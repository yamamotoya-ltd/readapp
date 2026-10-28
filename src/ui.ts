// The single-page input UI. Self-contained: no external scripts, styles or fonts.
// All server data is rendered with textContent / DOM APIs, never innerHTML.

const PAGE = String.raw`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>readapp</title>
<style>
:root{--bg:#f5f5f7;--card:#fff;--fg:#1d1d1f;--sub:#6e6e73;--line:#d2d2d7;--accent:#0a64d8;--accent-fg:#fff;--bad:#d70015;--ok:#1a7f37}
@media (prefers-color-scheme: dark){:root{--bg:#000;--card:#1c1c1e;--fg:#f5f5f7;--sub:#98989d;--line:#3a3a3c;--accent:#4c9bff;--accent-fg:#000;--bad:#ff6961;--ok:#4cc26a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;padding:16px;padding-bottom:calc(32px + env(safe-area-inset-bottom))}
main{max-width:640px;margin:0 auto}
h1{font-size:24px;margin:8px 0 4px}
h2{font-size:18px;margin:0 0 12px}
.sub{color:var(--sub);font-size:14px;margin:0 0 16px}
section{background:var(--card);border-radius:14px;padding:16px;margin-bottom:16px}
label{display:block;font-weight:600;margin:12px 0 6px}
input,textarea{width:100%;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px}
textarea{min-height:42vh;resize:vertical}
button{font:inherit;min-height:48px;padding:0 20px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);font-weight:600;width:100%;margin-top:12px}
button.small{min-height:44px;font-size:14px}
button:disabled{opacity:.5}
.count{font-size:14px;color:var(--sub);margin-top:6px}
.count.over{color:var(--bad);font-weight:600}
.msg{color:var(--bad);margin-top:8px;font-size:14px;white-space:pre-wrap}
ul{list-style:none;margin:0;padding:0}
li{padding:12px 0;border-top:1px solid var(--line)}
li:first-child{border-top:0}
.t{font-weight:600;word-break:break-word}
.meta{font-size:14px;color:var(--sub)}
.st-done{color:var(--ok)}.st-failed{color:var(--bad)}
.err{font-size:14px;color:var(--bad);word-break:break-word}
.row{display:flex;gap:8px}.row input{flex:1}
ol{padding-left:20px;margin:12px 0}
.danger{margin-top:12px}
</style>
</head>
<body>
<main>
<h1>readapp</h1>
<p class="sub" id="usage">今月の残り: - / 上限 -</p>

<section>
<h2>新しい音声</h2>
<form id="form">
<label for="title">タイトル（任意）</label>
<input id="title" autocomplete="off">
<label for="text">本文</label>
<textarea id="text" required></textarea>
<div class="count" id="count">0字</div>
<button class="primary" id="submit" type="submit">音声にする</button>
<div class="msg" id="formmsg" role="alert"></div>
</form>
</section>

<section>
<h2>エピソード</h2>
<ul id="list"></ul>
<p class="meta" id="empty">まだありません。</p>
</section>

<section>
<h2>Apple Podcastsに登録</h2>
<div class="row"><input id="feed" readonly aria-label="フィードURL"><button id="copy" type="button">コピー</button></div>
<ol>
<li>Podcastsアプリ →ライブラリ →右上の「…」→「URLで番組をフォロー」に貼り付け</li>
</ol>
<button class="small danger" id="rotate" type="button">URLを作り直す</button>
<div class="msg" id="feedmsg"></div>
</section>
</main>
<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  var state=null,timer=null;
  function fmtNum(n){return Number(n).toLocaleString('ja-JP')}
  function fmtDate(iso){
    var p=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(iso));
    var g=function(t){var x=p.find(function(q){return q.type===t});return x?x.value:''};
    return g('month')+'/'+g('day')+' '+g('hour')+':'+g('minute');
  }
  function api(path,opts){
    opts=opts||{};
    var o={method:opts.method||'GET',headers:{}};
    if(o.method==='POST'){o.headers['Content-Type']='application/json';o.body=JSON.stringify(opts.body||{});}
    return fetch(path,o).then(function(r){
      return r.json().catch(function(){return {}}).then(function(d){return {ok:r.ok,status:r.status,data:d}});
    });
  }
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}

  function statusNode(ep){
    var s=el('div','meta');
    if(ep.status==='done'){
      var sec=ep.duration_sec||0;
      s.className='meta st-done';
      s.textContent='完了（'+Math.floor(sec/60)+'分'+(sec%60)+'秒）';
    }else if(ep.status==='failed'){
      s.className='meta st-failed';s.textContent='失敗';
    }else{
      s.textContent='処理中（'+ep.done_chunks+'/'+ep.total_chunks+'）';
    }
    return s;
  }
  function render(){
    if(!state)return;
    $('usage').textContent='今月の残り: '+fmtNum(state.remaining)+'字 / 上限 '+fmtNum(state.monthlyLimit)+'字';
    $('feed').value=state.feedUrl;
    var list=$('list');
    while(list.firstChild)list.removeChild(list.firstChild);
    $('empty').hidden=state.episodes.length>0;
    state.episodes.forEach(function(ep){
      var li=el('li');
      li.appendChild(el('div','t',ep.title));
      li.appendChild(el('div','meta',fmtDate(ep.created_at)));
      li.appendChild(statusNode(ep));
      if(ep.status==='failed'){
        if(ep.error)li.appendChild(el('div','err',ep.error));
        var b=el('button','small','再実行');
        b.type='button';
        b.style.marginTop='8px';
        b.addEventListener('click',function(){
          b.disabled=true;
          api('/api/episodes/'+encodeURIComponent(ep.id)+'/retry',{method:'POST'}).then(function(r){
            if(!r.ok)alert(r.data.error||'失敗しました');
            load();
          });
        });
        li.appendChild(b);
      }
      list.appendChild(li);
    });
    updateCount();
    schedule();
  }
  function schedule(){
    clearTimeout(timer);timer=null;
    if(state&&state.episodes.some(function(e){return e.status==='processing'})){
      timer=setTimeout(load,5000);
    }
  }
  function load(){
    return api('/api/state').then(function(r){
      if(r.ok){state=r.data;render();}
      else if(r.status===401){$('formmsg').textContent='ログインが必要です。';}
    }).catch(function(){schedule()});
  }
  function updateCount(){
    var n=$('text').value.length,c=$('count');
    var max=state?state.maxCharsPerEpisode:0;
    c.textContent=fmtNum(n)+'字'+(max?' / 1本あたり最大'+fmtNum(max)+'字':'');
    c.className='count'+(max&&n>max?' over':'');
  }
  $('text').addEventListener('input',updateCount);
  $('form').addEventListener('submit',function(ev){
    ev.preventDefault();
    var btn=$('submit');btn.disabled=true;$('formmsg').textContent='';
    api('/api/episodes',{method:'POST',body:{text:$('text').value,title:$('title').value}}).then(function(r){
      if(r.ok){$('text').value='';$('title').value='';updateCount();return load();}
      $('formmsg').textContent=r.data.error||'失敗しました。';
    }).catch(function(){$('formmsg').textContent='通信に失敗しました。'}).then(function(){btn.disabled=false});
  });
  $('copy').addEventListener('click',function(){
    var v=$('feed').value,b=$('copy');
    var done=function(){b.textContent='コピーしました';setTimeout(function(){b.textContent='コピー'},1500)};
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(v).then(done,function(){$('feed').select()});
    }else{$('feed').select();}
  });
  $('rotate').addEventListener('click',function(){
    if(!confirm('URLを作り直すと、今のURLは使えなくなります。Podcastsアプリで新しいURLを登録し直す必要があります。よろしいですか？'))return;
    api('/api/feed-token/rotate',{method:'POST'}).then(function(r){
      if(r.ok)return load();
      $('feedmsg').textContent=r.data.error||'失敗しました。';
    });
  });
  load();
})();
</script>
</body>
</html>
`;

export function uiHtml(): string {
  return PAGE;
}
