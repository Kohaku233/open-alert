import { t } from './i18n.js';
import type { ApiResponse, ApiRouteMap } from '../src/contracts/api.js';
export interface AuthCapabilities {
    google: boolean;
    emailOtp: boolean;
    registration: 'invite' | 'open' | 'closed';
}
export class AppError extends Error {
    constructor(public code: string, message: string, public status = 0, public requestId = '', public retryAfter: string | null = null, public retryAt = 0) {
        super(message);
        this.name = 'AppError';
    }
}
// Only business API traffic shares this budget. Better Auth/OTP and login discovery
// have their own limits and must remain usable during a workspace cooldown.
let businessCooldown: AppError | null = null;
const cooldownListeners = new Set<(error: AppError) => void>();
const FALLBACK_RETRY_MS = 60000;
export function retryDeadline(value: string | null, now = Date.now()): number {
    const text = value?.trim() ?? '';
    const seconds = /^\d+$/.test(text) ? Number(text) : NaN;
    // Date.parse accepts some malformed numeric strings as dates; require HTTP-date shape.
    const date = /^[A-Za-z]{3}, /.test(text) || /^[A-Za-z]+, /.test(text) || /^[A-Za-z]{3} [A-Za-z]{3} /.test(text) ? Date.parse(text) : NaN;
    const deadline = Number.isFinite(seconds) ? now + seconds * 1000 : date;
    return Number.isFinite(deadline) && deadline > now ? deadline : now + FALLBACK_RETRY_MS;
}
export function getBusinessCooldown(): AppError | null { return businessCooldown; }
export function assertBusinessReady(): void {
    if (businessCooldown && Date.now() < businessCooldown.retryAt)
        throw businessCooldown;
}
export function subscribeBusinessCooldown(listener: (error: AppError) => void): () => void {
    cooldownListeners.add(listener);
    return () => { cooldownListeners.delete(listener); };
}
function isBusinessApi(path: string): boolean {
    const url = new URL(path, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/') && url.pathname !== '/api/auth-capabilities';
}
export async function request<T>(path: string, method = 'GET', body?: unknown, options: {
    signal?: AbortSignal;
    bearer?: string;
} = {}): Promise<T> {
    const business = isBusinessApi(path);
    // Synchronous gate before every fetch: a blocked mutation is rejected, never queued
    // for automatic replay. Already dispatched requests are allowed to finish.
    if (business)
        assertBusinessReady();
    const headers = new Headers({ Accept: 'application/json' });
    if (body !== undefined)
        headers.set('Content-Type', 'application/json');
    if (options.bearer)
        headers.set('Authorization', `Bearer ${options.bearer}`);
    let response: Response;
    try {
        response = await fetch(path, {
            method, headers, credentials: 'same-origin', cache: 'no-store',
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        });
    }
    catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
            throw error;
        if (method !== 'GET')
            throw new AppError('request_uncertain', t("未收到操作结果，可能已经生效。请重新读取状态；测试通知请先查看手机，避免重复发送。"));
        throw new AppError('network_error', t("无法连接服务，请检查网络后重试。"));
    }
    // Observe the status/header before parsing the body, including proxy HTML 429s.
    const limited = response.status === 429 ? new AppError('rate_limited', t("请求过于频繁，请稍后重试。"), 429, '', response.headers.get('Retry-After'), retryDeadline(response.headers.get('Retry-After'))) : null;
    if (limited && business) {
        if (!businessCooldown || limited.retryAt >= businessCooldown.retryAt)
            businessCooldown = limited;
        for (const listener of cooldownListeners)
            listener(businessCooldown);
    }
    let envelope: ApiResponse<T>;
    try {
        envelope = await response.json() as ApiResponse<T>;
    }
    catch {
        throw limited ?? new AppError('invalid_response', t("服务返回了无法读取的响应，请稍后重试。"), response.status);
    }
    if (limited) {
        if (envelope && typeof envelope.requestId === 'string')
            limited.requestId = envelope.requestId;
        throw limited;
    }
    if (!envelope || typeof envelope.ok !== 'boolean' || typeof envelope.requestId !== 'string') {
        throw new AppError('invalid_response', t("服务响应格式不正确，请联系部署管理员。"), response.status);
    }
    if (!envelope.ok) {
        throw new AppError(envelope.error.code, envelope.error.message, response.status, envelope.requestId, response.headers.get('Retry-After'));
    }
    if (!response.ok || !('data' in envelope))
        throw new AppError('invalid_response', t("服务响应不完整，请稍后重试。"), response.status, envelope.requestId);
    return envelope.data;
}
export function api<K extends keyof ApiRouteMap>(route: K, body?: ApiRouteMap[K]['request'], id?: string): Promise<ApiRouteMap[K]['response']> {
    const [method, rawPath] = route.split(' ');
    const path = rawPath!.replace(':id', encodeURIComponent(id ?? ''));
    return request<ApiRouteMap[K]['response']>(path, method, body);
}
const messages: Record<string, string> = {
    get unauthenticated() {
        return t("登录已失效，请重新登录。");
    },
    get forbidden() {
        return t("账户已停用，或你没有此操作的权限。");
    },
    get generation_conflict() {
        return t("数据已在其他页面更新。已刷新当前状态，请检查后重试。");
    },
    get pending_delivery() {
        return t("通知正在排队或发送，暂时无法修改。请等待完成；暂停监控会取消尚未发送的通知。");
    },
    get limit_exceeded() {
        return t("已达到警报、市场或用户数量上限，请先清理已有项目。");
    },
    get channel_unconfigured() {
        return t("请先配置 Pushover 用户密钥和可用的应用令牌。");
    },
    get notification_uncertain() {
        return t("测试投递结果不确定，可能已经送达。请先查看手机，避免重复发送。");
    },
    get notification_failed() {
        return t("Pushover 未确认投递成功，请检查密钥和服务状态。");
    },
    get rate_limited() {
        return t("请求过于频繁，请稍后重试。");
    },
    get service_unavailable() {
        return t("服务暂时不可用，请检查下方运行状态或稍后重试。");
    },
    get not_found() {
        return t("该项目已不存在，请刷新页面。");
    },
    get invalid_request() {
        return t("提交内容不符合要求，请检查输入。");
    },
    get internal_error() {
        return t("服务处理失败，请联系管理员并提供请求编号。");
    },
};
export function errorText(error: unknown, now = Date.now()): string {
    if (error instanceof AppError) {
        const text = messages[error.code] ?? error.message;
        const wait = error.retryAt ? (error.retryAt > now ? t(" 重试等待：{0} 秒。", Math.ceil((error.retryAt - now) / 1000)) : t(" 等待已结束，可手动重试操作。")) : error.retryAfter ? t(" 重试等待：{0}。", error.retryAfter) : '';
        return `${text}${wait}${error.requestId ? t(" 请求编号：{0}", error.requestId) : ''}`;
    }
    return t("操作未完成，请检查网络并重试。");
}
// Callback queries are untrusted. Keep only canonical allowlisted codes; never
// render provider messages, authorization codes, tokens, or redirect destinations.
const oauthMessages: Record<string, string> = {
    get account_not_linked() {
        return t("Google 登录未能完成账户关联，请尝试邮箱验证码登录，或联系管理员。");
    },
    get invalid_code() {
        return t("Google 登录凭证无效或已过期，请重新发起登录，也可使用邮箱验证码。");
    },
    get access_denied() {
        return t("Google 登录已取消或未获授权，请重新发起登录，也可使用邮箱验证码。");
    },
    get state_mismatch() {
        return t("Google 登录验证状态不匹配，请从此页面重新发起登录，也可使用邮箱验证码。");
    },
    get state_not_found() {
        return t("Google 登录请求已过期或验证状态已丢失，请重新发起登录，也可使用邮箱验证码。");
    },
    get invitation_required() {
        return t("此邮箱尚未获得邀请，请联系管理员确认邀请后登录。也可尝试获邀邮箱的验证码登录。");
    },
    get account_disabled() {
        return t("此账户已停用，请联系管理员。");
    },
    get registration_closed() {
        return t("新账户注册已关闭，请使用已有账户登录或联系管理员。");
    },
    get oauth_failed() {
        return t("Google 登录未完成，请重试或使用邮箱验证码登录；若仍失败，请联系管理员。");
    },
};
const oauthAliases: Record<string, string> = {
    invite_required: 'invitation_required', user_disabled: 'account_disabled',
    state_expired: 'state_not_found', signup_disabled: 'registration_closed',
};
function safeOAuthCode(code: string): string {
    const lower = code.toLowerCase();
    const canonical = Object.hasOwn(oauthAliases, lower) ? oauthAliases[lower]! : lower;
    return Object.hasOwn(oauthMessages, canonical) ? canonical : 'oauth_failed';
}
export function loginCallbackURL(search: string): string {
    const params = new URLSearchParams(search);
    return params.has('error') ? `/login?error=${safeOAuthCode(params.get('error') ?? '')}` : '/login';
}
export function oauthCallbackErrorText(search: string): string {
    const params = new URLSearchParams(search);
    return params.has('error') ? oauthMessages[safeOAuthCode(params.get('error') ?? '')]! : '';
}
export function oauthErrorText(error: {
    code?: string | undefined;
    status?: number | undefined;
} | null): string {
    return error?.status === 429 ? t("请求过于频繁，请稍后重试。") : oauthMessages[safeOAuthCode(error?.code ?? '')]!;
}
export function authErrorText(error: {
    code?: string | undefined;
    status?: number | undefined;
} | null): string {
    const mapped: Record<string, string> = {
        get INVALID_OTP() {
            return t("验证码不正确或已过期，请重新输入或发送。");
        },
        get OTP_EXPIRED() {
            return t("验证码已过期，请重新发送。");
        },
        get TOO_MANY_ATTEMPTS() {
            return t("验证码尝试次数已用完，请重新发送。");
        },
        get USER_NOT_FOUND() {
            return t("该邮箱无法登录，请联系管理员确认邀请。");
        },
        get INVITE_REQUIRED() {
            return t("该邮箱尚未获得邀请，请联系管理员。");
        },
        get INVITATION_REQUIRED() {
            return t("该邮箱尚未获得邀请，请联系管理员。");
        },
        get REGISTRATION_CLOSED() {
            return t("新账户注册已关闭。");
        },
        get USER_DISABLED() {
            return t("此账户已停用，请联系管理员。");
        },
        get ACCOUNT_DISABLED() {
            return t("此账户已停用，请联系管理员。");
        },
        get INVALID_EMAIL() {
            return t("请输入有效的邮箱地址。");
        },
    };
    const code = error?.code?.toUpperCase() ?? '';
    return (Object.hasOwn(mapped, code) && mapped[code]) || (error?.status === 429 ? t("请求过于频繁，请稍后重试。") : t("登录操作未完成，请检查邮箱、邀请资格或联系管理员。"));
}
