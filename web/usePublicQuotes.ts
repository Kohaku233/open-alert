import {useEffect,useState} from 'react';
import type {PublicMarketPreview} from '../src/markets/public-preview.js';
import {request} from './api.js';

export function usePublicQuotes() {
  const [state,setState]=useState<{data:PublicMarketPreview|null;pending:boolean;failed:boolean}>({data:null,pending:true,failed:false});
  useEffect(()=>{
    let disposed=false,timer:number|undefined,controller:AbortController|null=null;
    async function read(){
      if(disposed||document.hidden||controller)return;
      controller=new AbortController();
      try{
        const data=await request<PublicMarketPreview>('/api/public-quotes','GET',undefined,{signal:controller.signal});
        if(data.entries.length!==3||!Number.isSafeInteger(data.capturedAt))throw new Error('invalid_preview');
        if(!disposed)setState({data,pending:false,failed:false});
      }catch(error){if(!disposed&&!controller.signal.aborted)setState(previous=>({...previous,pending:false,failed:true}));}
      finally{controller=null;if(!disposed&&!document.hidden)timer=window.setTimeout(read,5000);}
    }
    const visible=()=>{window.clearTimeout(timer);if(!document.hidden)void read();};
    document.addEventListener('visibilitychange',visible);void read();
    return()=>{disposed=true;window.clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',visible);};
  },[]);
  return state;
}
