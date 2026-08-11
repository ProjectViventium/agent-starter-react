/* VIVENTIUM START
 * Purpose: Strip the fragment bearer during HTML parsing, before hydration/bundle/network delay.
 * This generic script contains no capability or session value from the server response.
 * VIVENTIUM END */
export const CALL_CAPABILITY_BOOTSTRAP_SCRIPT = `(function(){
var i='',c='',l='',n='',p='',b='',d='';
var si=/^[A-Za-z0-9._:-]{1,160}$/;
var sc=/^[A-Za-z0-9_-]{43}$/;
function go(){window.location.replace(d);}
function randomCapability(){if(!window.crypto||typeof window.crypto.getRandomValues!=='function'||typeof window.btoa!=='function')return '';var a=new Uint8Array(32);window.crypto.getRandomValues(a);var s='';for(var x=0;x<a.length;x+=1)s+=String.fromCharCode(a[x]);return window.btoa(s).split('+').join('-').split('/').join('_').replace(/=+$/,'');}
function rememberOpener(){try{var r=new URL(document.referrer);if((r.protocol==='http:'||r.protocol==='https:')&&r.origin===r.protocol+'//'+r.host){window.sessionStorage.setItem('viventium.call.opener-origin.v1:'+i,r.origin);}}catch(_){}}
try{
 var q=new URLSearchParams(window.location.search);
 i=(q.get('callSessionId')||'').trim();
 var h=window.location.hash||'';
 var hp=new URLSearchParams(h.charAt(0)==='#'?h.slice(1):h);
 c=(hp.get('viventiumCallCapability')||'').trim();
 l=(hp.get('viventiumCallLaunch')||'').trim();
 window.history.replaceState(window.history.state,'',window.location.pathname+window.location.search);
 p=window.location.pathname||'';
 b=p.endsWith('/call-bootstrap')?p.slice(0,-15):'';
 d=si.test(i)?b+'/?callSessionId='+encodeURIComponent(i)+'&autoConnect=1':b+'/';
 if(si.test(i)&&sc.test(c)){
  window.sessionStorage.setItem('viventium.call.capability.v1:'+i,c);
  rememberOpener();
  go();
  return;
 }
 if(!si.test(i)||!sc.test(l)||typeof window.fetch!=='function'){
  go();
  return;
 }
 var nk='viventium.call.launch-idempotency.v1:'+i;
 n=(window.sessionStorage.getItem(nk)||'').trim();
 if(!sc.test(n)){n=randomCapability();if(sc.test(n))window.sessionStorage.setItem(nk,n);}
 if(!sc.test(n)){go();return;}
 var attempts=0;
 function exchange(){
  attempts+=1;
  var controller=typeof window.AbortController==='function'?new window.AbortController():null;
  var timeout=controller&&typeof window.setTimeout==='function'?window.setTimeout(function(){controller.abort();},5000):null;
  window.fetch(b+'/api/call-launch-exchange?callSessionId='+encodeURIComponent(i),{
   method:'POST',
   headers:{'X-VIVENTIUM-CALL-LAUNCH':l,'X-VIVENTIUM-CALL-LAUNCH-IDEMPOTENCY':n},
   cache:'no-store',
   credentials:'same-origin',
   redirect:'error',
   signal:controller?controller.signal:undefined
  }).then(function(response){
   if(timeout!==null&&typeof window.clearTimeout==='function')window.clearTimeout(timeout);
   return response.text().then(function(text){return {response:response,text:text};});
  }).then(function(result){
   var payload={};
   try{payload=result.text?JSON.parse(result.text):{};}catch(_){}
   if(result.response.ok&&payload&&payload.version===1&&payload.callSessionId===i&&sc.test(payload.browserCapability||'')){
    window.sessionStorage.setItem('viventium.call.capability.v1:'+i,payload.browserCapability);
    window.sessionStorage.removeItem(nk);
    rememberOpener();
    go();
    return;
   }
   if((result.response.status===408||result.response.status===429||result.response.status>=500)&&attempts<3){
    window.setTimeout(exchange,attempts*250);
    return;
   }
   go();
  }).catch(function(){
   if(timeout!==null&&typeof window.clearTimeout==='function')window.clearTimeout(timeout);
   if(attempts<3){window.setTimeout(exchange,attempts*250);return;}
   go();
  });
 }
 exchange();
}catch(_){
 try{if(window.location.hash)window.history.replaceState(window.history.state,'',window.location.pathname+window.location.search);}catch(__){}
 window.location.replace('/');
}
})();`;
