/** Portable bounded fetch; timeout covers both headers and streaming body. */
export type Fetch = typeof globalThis.fetch;
export class HttpError extends Error {
  constructor(public readonly code: 'request_timeout'|'transport_error'|'redirect_rejected'|'response_too_large'|'invalid_response') { super(code); this.name='HttpError'; }
}
export async function boundedJson(url: string, init: RequestInit, options: {fetch?: Fetch; timeoutMs: number; maxBytes: number}): Promise<{status:number; data:unknown}> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000 || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 2 * 1024 * 1024) throw new HttpError('invalid_response');
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async () => {
    const response = await (options.fetch ?? globalThis.fetch)(url,{...init,redirect:'manual',signal:controller.signal});
    if (controller.signal.aborted) { void response.body?.cancel().catch(()=>{}); throw new HttpError('request_timeout'); }
    if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(()=>{}); throw new HttpError('redirect_rejected'); }
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared)>options.maxBytes)) { void response.body?.cancel().catch(()=>{}); throw new HttpError('response_too_large'); }
    if (!response.body) throw new HttpError('invalid_response');
    reader=response.body.getReader(); let size=0; const chunks: Uint8Array[]=[];
    while (true) { const part=await reader.read(); if(part.done) break; size+=part.value.byteLength; if(size>options.maxBytes) throw new HttpError('response_too_large'); chunks.push(part.value); }
    const body=new Uint8Array(size); let offset=0; for(const chunk of chunks) {body.set(chunk,offset);offset+=chunk.length;}
    try { return {status:response.status,data:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)) as unknown}; }
    catch { throw new HttpError('invalid_response'); }
  };
  try {
    return await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new HttpError('request_timeout'));},options.timeoutMs);})]);
  } catch(error) { controller.abort(); if(reader) void reader.cancel().catch(()=>{}); throw error instanceof HttpError ? error : new HttpError('transport_error'); }
  finally { if(timer!==undefined) clearTimeout(timer); if(reader) { try { reader.releaseLock(); } catch {} } }
}
