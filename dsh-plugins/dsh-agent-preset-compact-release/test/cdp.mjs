export async function connect(endpoint,url='about:blank'){
 const target=await (await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`,{method:'PUT',signal:AbortSignal.timeout(5000)})).json();
 const ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP websocket open timeout')),5000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',e=>{clearTimeout(timer);reject(e);},{once:true});});
 let seq=0;const pending=new Map(),listeners=new Map();
 ws.addEventListener('message',event=>{const r=JSON.parse(event.data);if(r.id){const p=pending.get(r.id);if(!p)return;clearTimeout(p.timer);pending.delete(r.id);if(r.error)p.reject(Error(r.error.message));else p.resolve(r.result);}else for(const fn of listeners.get(r.method)||[])Promise.resolve(fn(r.params)).catch(console.error);});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout ${method} (15000ms)`));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text+' '+r.exceptionDetails.exception?.description);return r.result.value;};
 return {send,evaluate,on:(event,fn)=>{const list=listeners.get(event)||[];list.push(fn);listeners.set(event,list);},close:async()=>{try{await fetch(`${endpoint}/json/close/${target.id}`,{signal:AbortSignal.timeout(3000)});}finally{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('CDP closed'));}pending.clear();ws.close();}}};
}
