// Deck — чистые format/markdown-хелперы (без DOM). D4c: вынесено из index.html.
const ctxColor = v => v >= 0.8 ? 'var(--bad)' : v >= 0.5 ? 'var(--warn)' : 'var(--good)';
const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const escHtml = esc;
const pctOf = s => Math.round((s.ctxPct||0)*100);
const kTok = n => (n>=1000 ? Math.round(n/1000)+'k' : String(n||0));
function timeAgo(ms){
  if (!ms) return '—';
  const min = Math.round((Date.now()-ms)/60000);
  if (min < 1) return 'только что';
  if (min < 60) return min+' мин назад';
  const h = Math.round(min/60); if (h < 24) return h+' ч назад';
  const day = Math.round(h/24); if (day < 30) return day+' дн назад';
  return new Date(ms).toLocaleDateString('ru-RU');
}

/* ---------- markdown → html (zero-dep, escape-first) ---------- */
function mdInline(t){
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (m,c)=>{ codes.push(c); return 'C'+(codes.length-1)+''; });
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m,txt,url)=>{
    // относительные пути (docs/plan.md) — валидные ЛОКАЛЬНЫЕ ссылки: их ловит глобальный обработчик и открывает
    // во встроенном просмотрщике. Раньше они подменялись на '#' (мёртвая ссылка) — оттого клик «ничего не делал».
    // Режем только опасные схемы.
    const safe = /^\s*(javascript|data|vbscript):/i.test(url) ? '#' : url;
    return '<a href="'+safe+'" target="_blank" rel="noopener">'+txt+'</a>';
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_\w])_([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>');
  t = t.replace(/C(\d+)/g, (m,i)=>'<code class="cx-ic">'+codes[+i]+'</code>');
  return t;
}
function mdToHtml(src){
  let s = String(src==null ? '' : src);
  const blocks = [];
  s = s.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m,lang,code)=>{
    blocks.push('<pre class="cx-code"><button class="code-copy" type="button" title="Копировать">⧉</button><code>'+esc(code.replace(/\n+$/,''))+'</code></pre>');
    return ' B'+(blocks.length-1)+' ';
  });
  s = esc(s);
  const lines = s.split('\n');
  const html = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length){ html.push('<p>'+mdInline(para.join(' '))+'</p>'); para=[]; } };
  const flushList = () => { if (list){ html.push('<'+list.type+'>'+list.items.map(x=>'<li>'+mdInline(x)+'</li>').join('')+'</'+list.type+'>'); list=null; } };
  for (const line of lines){
    const mf = line.match(/^ B(\d+) $/);
    if (mf){ flushPara(); flushList(); html.push(blocks[+mf[1]]); continue; }
    if (/^\s*$/.test(line)){ flushPara(); flushList(); continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)){ flushPara(); flushList(); html.push('<hr>'); continue; }
    const mh = line.match(/^(#{1,6})\s+(.*)$/);
    if (mh){ flushPara(); flushList(); const lvl=Math.min(mh[1].length,6); html.push('<h'+lvl+'>'+mdInline(mh[2])+'</h'+lvl+'>'); continue; }
    const mq = line.match(/^\s*&gt;\s?(.*)$/);
    if (mq){ flushPara(); flushList(); html.push('<blockquote>'+mdInline(mq[1])+'</blockquote>'); continue; }
    const mu = line.match(/^\s*[-*]\s+(.*)$/);
    if (mu){ flushPara(); if (!list||list.type!=='ul'){ flushList(); list={type:'ul',items:[]}; } list.items.push(mu[1]); continue; }
    const mo = line.match(/^\s*\d+\.\s+(.*)$/);
    if (mo){ flushPara(); if (!list||list.type!=='ol'){ flushList(); list={type:'ol',items:[]}; } list.items.push(mo[1]); continue; }
    if (list) flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  let out = html.join('\n');
  out = out.replace(/ B(\d+) /g, (m,i)=>blocks[+i]);
  return out;
}
function fmtTok(n){ n = n||0; return n>=1000 ? (Math.round(n/100)/10)+'k' : String(n); }

export { ctxColor, esc, escHtml, pctOf, kTok, timeAgo, mdInline, mdToHtml, fmtTok };
