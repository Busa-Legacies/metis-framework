/* ============================================================== *
 * Morph deck engine. A deck is data: define window.DECK before
 * loading this file. Mechanic = View Transitions API — the web twin
 * of PowerPoint's `morph option="byObject"`: updating the DOM inside
 * document.startViewTransition() morphs every shared `view-transition
 * -name` (hero, navbar, pageno, orb) between its old and new box,
 * while un-named pinned anchors hold still. Falls back to an instant
 * cut where View Transitions aren't supported.
 *
 *   window.DECK = {
 *     brand:'OPENCLAW', pill:'v2026.5', credit:'metis os',
 *     nav:[{p:'gateway',s:'core'}, ...],         // bottom-nav items
 *     slides:[                                    // [0] = cover
 *       {hero:'OPENCLAW', sub:'…', cover:true, orb:{t,l,d}},
 *       {hero:'gateway', head:'about…', body:'…html…', orb:{t,l,d}},
 *     ]
 *   }
 * ============================================================== */
(function(){
  const D = window.DECK || {};
  const $ = s => document.querySelector(s);

  // text anchors
  $('.brand').textContent = D.brand || '';
  $('.pill-btn').textContent = D.pill || '';
  $('.credit').innerHTML = D.credit || '';

  const stage=$('#stage'), hero=$('#hero'), subtitle=$('#subtitle'),
        headline=$('#headline'), body=$('#body'), pageno=$('#pageno'),
        orb=$('#orb'), navEl=$('#nav'), navbar=$('#navbar'), dotsEl=$('#dots');
  const SLIDES = D.slides || [];
  let idx = 0;

  (D.nav||[]).forEach((n,i)=>{
    const d=document.createElement('div'); d.className='nav-item'; d.dataset.i=i+1;
    d.innerHTML=`<span class="p">${n.p}</span><span class="s">${n.s}</span>`;
    d.onclick=()=>go(i+1); navEl.appendChild(d);
  });
  SLIDES.forEach((_,i)=>{const b=document.createElement('b'); b.onclick=()=>go(i); dotsEl.appendChild(b);});

  function render(){
    const s=SLIDES[idx]||{};
    stage.classList.toggle('cover', !!s.cover);
    stage.classList.toggle('content', !s.cover);
    hero.innerHTML = s.cover ? (s.hero||'') : `${s.hero||''}<span class="leaf">◆</span>`;
    subtitle.textContent = s.sub||'';
    headline.textContent = s.head||'';
    body.innerHTML = s.body||'';
    pageno.textContent = String(idx).padStart(2,'0');
    if(s.orb){ orb.style.width=orb.style.height=s.orb.d; orb.style.top=s.orb.t; orb.style.left=s.orb.l; }
    const items=[...navEl.querySelectorAll('.nav-item')];
    items.forEach((it,i)=> it.classList.toggle('on', (i+1)===idx));
    const active=items[idx-1];
    if(active){
      const r=active.getBoundingClientRect(), nr=navEl.getBoundingClientRect();
      navbar.style.opacity='1'; navbar.style.left=(r.left-nr.left)+'px'; navbar.style.width=r.width+'px';
    } else { navbar.style.opacity='0'; }
    [...dotsEl.children].forEach((b,i)=>b.classList.toggle('on', i===idx));
  }

  function go(n){
    n=Math.max(0, Math.min(SLIDES.length-1, n));
    if(n===idx) return;
    if(document.startViewTransition){ document.startViewTransition(()=>{ idx=n; render(); }); }
    else { idx=n; render(); }
  }
  const next=()=>go(idx+1), prev=()=>go(idx-1);

  $('#zr').onclick=next; $('#zl').onclick=prev;
  addEventListener('keydown',e=>{
    if(['ArrowRight','ArrowDown',' ','PageDown'].includes(e.key)){e.preventDefault();next();}
    if(['ArrowLeft','ArrowUp','PageUp'].includes(e.key)){e.preventDefault();prev();}
    if(e.key==='Home')go(0); if(e.key==='End')go(SLIDES.length-1);
  });
  let tx=0;
  addEventListener('touchstart',e=>tx=e.touches[0].clientX,{passive:true});
  addEventListener('touchend',e=>{const dx=e.changedTouches[0].clientX-tx;
    if(Math.abs(dx)>45){dx<0?next():prev();}},{passive:true});
  addEventListener('resize',render);

  document.title = (D.brand||'Deck') + (D.titleSuffix||' — Morph Deck');
  render();
})();
