export async function connect(url='about:blank') {
 const target=await (await fetch(`http://127.0.0.1:59223/json/new?${encodeURIComponent(url)}`,{method:'PUT'})).json();
 const ws=new WebSocket(target.webSocketDebuggerUrl); await new Promise((ok,fail)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',fail,{once:true})});
 let seq=0; const pending=new Map();
 const listeners=new Map();
 ws.addEventListener('message',e=>{const r=JSON.parse(e.data);if(r.id){const p=pending.get(r.id);pending.delete(r.id);if(r.error)p.reject(Error(r.error.message));else p.resolve(r.result)}else for(const fn of listeners.get(r.method)||[])fn(r.params)});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text+' '+r.exceptionDetails.exception?.description);return r.result.value};
 return {send,evaluate,on:(event,fn)=>{const list=listeners.get(event)||[];list.push(fn);listeners.set(event,list)},close:async()=>{await fetch(`http://127.0.0.1:59223/json/close/${target.id}`);ws.close()}};
}
