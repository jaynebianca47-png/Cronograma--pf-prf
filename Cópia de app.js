/* ===============================
   Cronograma PF + PRF — App Core (v2.2)
   Dados salvos em localStorage
   =============================== */

const LS_KEY = "cronograma_pf_prf_v2_2"; // nova versão do storage

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const state = {
  startDate: null,
  endDate: null,
  weekdayMin: 90,
  weekendTotal: 180,
  weekendSplit: true,
  weeklyQs: 100,
  replanMargin: 30,
  carryQuestions: true,
  raiseDaily: true,
  exams: { PF: true, PRF: true },
  disciplines: {},
  planByDate: {},
  historyWeeks: [],
  alerts: { enabled:false, weekdayTime:"19:00", weekendTime:"09:00", leadMin:10, sound:true, oneOff:{} },
  review: { enabled:true, percent:30, n:2, days:[1,3,6] },
  account: { alfaconEmail: "jaynebianca47@gmail.com", qcEmail: "jaynebianca47@gmail.com", copyOnOpen: true },
  _timers: []
};

// -------- Datas
const toISO = (d) => d.toISOString().slice(0,10);
const fromISO = (s) => new Date(s + "T00:00:00");
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const startOfWeek = (d) => { const x = new Date(d); const w = x.getDay(); const diff = (w===0?6:w-1); x.setDate(x.getDate()-diff); x.setHours(0,0,0,0); return x; };
const endOfWeek = (d) => addDays(startOfWeek(d), 6);
const startOfMonth = (d) => { const x = new Date(d); x.setDate(1); return x; };
const endOfMonth = (d) => { const x = new Date(d); x.setMonth(x.getMonth()+1,0); return x; };

// -------- Utils
function parseTimeHHMM(t="19:00"){ const [h,m] = t.split(":").map(n=>parseInt(n,10)); return {h:isNaN(h)?19:h, m:isNaN(m)?0:m}; }
function msUntil(dateObj){ return Math.max(0, dateObj.getTime() - Date.now()); }
function atTimeOnDate(dateISO, timeHHMM, leadMin=0){ const {h,m} = parseTimeHHMM(timeHHMM); const d = fromISO(dateISO); d.setHours(h, m, 0, 0); if (leadMin>0) d.setMinutes(d.getMinutes() - leadMin); return d; }
function clearTimers(){ (state._timers||[]).forEach(id => clearTimeout(id)); state._timers = []; }
function pad2(n){ return (n<10?"0":"")+n; }
function toGCalDateTime(dt){ // returns YYYYMMDDTHHMMSSZ using UTC
  const z = new Date(dt.getTime());
  const y = z.getUTCFullYear();
  const M = pad2(z.getUTCMonth()+1);
  const d = pad2(z.getUTCDate());
  const h = pad2(z.getUTCHours());
  const m = pad2(z.getUTCMinutes());
  const s = pad2(z.getUTCSeconds());
  return `${y}${M}${d}T${h}${m}${s}Z`;
}

// -------- Persistência
function save(){ localStorage.setItem(LS_KEY, JSON.stringify(state)); }
function load(){ const raw = localStorage.getItem(LS_KEY); if (!raw) return false; try{ Object.assign(state, JSON.parse(raw)); return true; }catch{ return false; } }

// -------- Disciplinas padrão
function ensureDefaultDisciplines(){ if (Object.keys(state.disciplines).length) return;
  addDisc("Português","ambos",2.0); addDisc("Raciocínio Lógico","ambos",1.5); addDisc("Informática","ambos",1.2); addDisc("Direito Constitucional","ambos",1.6); addDisc("Direito Administrativo","ambos",1.6);
  addDisc("Direito Penal","PF",2.0); addDisc("Processo Penal","PF",2.0); addDisc("Legislação Especial","PF",1.6); addDisc("Estatística","PF",1.0);
  addDisc("CTB / Legislação de Trânsito","PRF",2.5); addDisc("Direitos Humanos / Ética","PRF",1.2);
}
function addDisc(name, exam, weight){ state.disciplines[name] = { exam, weight:Number(weight) }; }

// -------- Métricas (acurácia) e pesos efetivos
function recomputeMetrics(){
  const metrics = {}; Object.keys(state.disciplines).forEach(n=>metrics[n] = {correct:0, wrong:0, total:0, acc:1});
  Object.values(state.planByDate).forEach(day => { (day.topics||[]).forEach(t => { const c=Number(t.qCorrect||0), w=Number(t.qWrong||0); const tot=c+w; if (tot>0){ if(!metrics[t.name]) metrics[t.name]={correct:0,wrong:0,total:0,acc:1}; metrics[t.name].correct+=c; metrics[t.name].wrong+=w; metrics[t.name].total+=tot; } }); });
  Object.values(metrics).forEach(m=>{ m.acc = m.total>0 ? (m.correct/m.total) : 1; });
  return metrics;
}
function getEffectiveWeights(){
  const base = state.disciplines; const metrics = recomputeMetrics(); const eff = {}; const alpha=0.6;
  for (const [name,d] of Object.entries(base)){
    const acc = (metrics[name]?.acc ?? 1); const difficulty = 1 - acc; let w = Number(d.weight)||1; let mult = 1 + alpha*difficulty; const wEff = Math.max(0.5*w, Math.min(2.0*w, w*mult)); eff[name] = { weight:wEff, base:w, acc, difficulty };
  }
  return eff;
}

// -------- Plano anual
function generatePlan(){ if (!state.startDate) state.startDate = toISO(new Date()); const start = fromISO(state.startDate); const months = Number($("#cfg-duration-months")?.value || 12); const end = new Date(start); end.setMonth(end.getMonth()+months); state.endDate = toISO(addDays(end,-1)); state.planByDate={}; state.historyWeeks=[];
  for (let d=new Date(start); d<=end; d=addDays(d,1)){
    const iso = toISO(d); const dow=d.getDay(); let minutesPlanned=0; if(dow>=1&&dow<=5) minutesPlanned=state.weekdayMin; if(dow===6||dow===0){ if(state.weekendSplit){ minutesPlanned=Math.floor(state.weekendTotal/2);} else if(dow===6){ minutesPlanned=state.weekendTotal;} else { minutesPlanned=0; } }
    const topics = minutesPlanned>0 ? allocateTopicsForDay(minutesPlanned) : [];
    const qDaily = Math.round(state.weeklyQs/5); const qWeekend = Math.max(0, Math.round((state.weeklyQs - qDaily*5)/2)); const qTarget = (dow>=1&&dow<=5)?qDaily:(qWeekend||0);
    state.planByDate[iso] = { minutesPlanned, minutesDone:0, topics, qTarget:Math.max(0,qTarget), qDone:0, advanced:false, done:false };
  }
  save();
}

function allocateTopicsForDay(minutes){ const effective=getEffectiveWeights(); const selected=Object.entries(state.disciplines).filter(([name,d])=>{ if(state.exams.PF&&state.exams.PRF) return true; if(state.exams.PF&&d.exam==="PF") return true; if(state.exams.PRF&&d.exam==="PRF") return true; return d.exam==="ambos"; });
  const sorted = selected.sort((a,b)=> (effective[b[0]]?.weight||b[1].weight) - (effective[a[0]]?.weight||a[1].weight)).slice(0, Math.min(4, selected.length||1));
  const sumEff = sorted.reduce((acc,[name])=> acc + (effective[name]?.weight||1), 0) || 1;
  let remaining=minutes; const topics=[]; for(let i=0;i<sorted.length;i++){ const [name]=sorted[i]; const baseShare = Math.round(minutes * ((effective[name]?.weight||1)/sumEff)/5)*5; const share = (i<sorted.length-1)?Math.max(15,baseShare):remaining; topics.push({ name, minutes:share, links:[], done:false, qCorrect:0, qWrong:0 }); remaining -= share; }
  if(remaining!==0 && topics.length) topics[topics.length-1].minutes += remaining; return topics; }

// -------- Revisão Semanal
function selectReviewSubjects(n){ const eff=getEffectiveWeights(); const arr=Object.entries(eff).map(([name,info])=>({name,acc:info.acc,weight:info.weight})); arr.sort((a,b)=> (a.acc - b.acc) || (b.weight - a.weight)); return arr.slice(0, Math.max(1,n)).map(x=>x.name); }

function applyReviewToDate(iso){ const day=state.planByDate[iso]; if(!day||day.minutesPlanned<=0) return; if(!state.review.enabled) return;
  const percent = Math.max(10, Math.min(50, Number(state.review.percent)||30)); const reviewMin = Math.round(day.minutesPlanned * (percent/100)/5)*5; if(reviewMin<=0) return;
  // remove antigos tópicos de revisão
  day.topics = (day.topics||[]).filter(t=>!t._review);
  const targets = selectReviewSubjects(Number(state.review.n)||2);
  const perTopic = Math.max(10, Math.round(reviewMin / targets.length /5)*5);
  const reviews = targets.map(name=>({ name:`Revisão: ${name}`, minutes:perTopic, links:[], done:false, qCorrect:0, qWrong:0, _review:true, _origin:name }));
  const totalReview = reviews.reduce((a,t)=>a+t.minutes,0);
  // redistribuir tempo: reduzir tópicos não revisão
  const others = day.topics; const sumOthers = others.reduce((a,t)=>a+t.minutes,0) || 1; const remaining = Math.max(0, day.minutesPlanned - totalReview);
  const scaled = others.map(t=>({ ...t, minutes: Math.max(10, Math.round((t.minutes/sumOthers)*remaining/5)*5) }));
  const diff = day.minutesPlanned - (totalReview + scaled.reduce((a,t)=>a+t.minutes,0)); if (scaled.length) scaled[scaled.length-1].minutes += diff;
  day.topics = [...reviews, ...scaled];
}

function applyReviewForWeek(weekStart){ if(!state.review.enabled) return; const daysSel = new Set(state.review.days||[]); for(let d=new Date(weekStart); d<=addDays(weekStart,6); d=addDays(d,1)){ const iso=toISO(d); const dow=d.getDay(); if(daysSel.has(dow)){ applyReviewToDate(iso); } } save(); }

function applyReviewForNextWeeks(startWeekStart, weeks=4){ let w = new Date(startWeekStart); for(let i=0;i<weeks;i++){ applyReviewForWeek(w); w = addDays(w,7); } renderWeek(); renderCalendar(); renderDashboard(); alert(`Revisão aplicada para as próximas ${weeks} semana(s).`); }

function autoApplyWeeklyReviewIfNeeded(){ if(!state.review.enabled) return; const today=new Date(); const dow=today.getDay(); if(dow===1){ const wk=startOfWeek(today); applyReviewForWeek(wk); renderWeek(); renderCalendar(); renderDashboard(); }}

// -------- Replanejamento semanal (questões/tempo)
function runReplan(referenceDate=new Date()){ const prevWeekEnd = addDays(startOfWeek(referenceDate), -1); const prevWeekStart = startOfWeek(prevWeekEnd); let qDone=0,qTarget=0,minDone=0,minPlan=0; for(let d=new Date(prevWeekStart); d<=prevWeekEnd; d=addDays(d,1)){ const iso=toISO(d); const day=state.planByDate[iso]; if(!day) continue; qDone+=(day.qDone||0); qTarget+=(day.qTarget||0); minDone+=(day.minutesDone||0); minPlan+=(day.minutesPlanned||0); }
  const qDeficit=Math.max(0,qTarget-qDone); if(!qDeficit && state.replanMargin<=0) return; const nextWeekStart=startOfWeek(referenceDate); const weeks=[nextWeekStart, addDays(nextWeekStart,7)]; let marginLeft=state.replanMargin; let remainingQs=state.carryQuestions?qDeficit:0; for(const wStart of weeks){ for(let d=new Date(wStart); d<=addDays(wStart,6); d=addDays(d,1)){ const iso=toISO(d); const day=state.planByDate[iso]; if(!day) continue; if(state.raiseDaily && remainingQs>0){ const bumpQs=Math.min(Math.ceil(remainingQs/5),10); day.qTarget+=bumpQs; remainingQs-=bumpQs; } if(marginLeft>0 && day.minutesPlanned>0){ const add=Math.min(15, marginLeft); day.minutesPlanned+=add; const totalBefore = day.topics.reduce((a,t)=>a+t.minutes,0) || 1; day.topics = day.topics.map(t=>({...t, minutes: Math.round((t.minutes/totalBefore)*(day.minutesPlanned)/5)*5 })); marginLeft-=add; } } } save(); }

// -------- Adiantar dia
function advanceOneDay(){ const today=new Date(); const todayIso=toISO(today); const futureDates=Object.keys(state.planByDate).filter(iso=> iso>todayIso && state.planByDate[iso].minutesPlanned>0); if(!futureDates.length) return alert("Não há dia futuro com estudo planejado para adiantar."); const iso=futureDates[0]; const future=state.planByDate[iso]; const todayDay=state.planByDate[todayIso]; if(!todayDay) return alert("Hoje não está dentro do período do cronograma."); const half=Math.ceil(future.topics.length/2); const moved=future.topics.splice(0,half); const movedMin=moved.reduce((a,t)=>a+t.minutes,0); const movedQ=Math.round(future.qTarget * (movedMin/Math.max(1,(future.minutesPlanned||1)))); todayDay.topics.push(...moved); todayDay.minutesPlanned+=movedMin; todayDay.qTarget+=movedQ; future.minutesPlanned-=movedMin; future.qTarget=Math.max(0,future.qTarget - movedQ); future.advanced=true; save(); renderWeek(); renderCalendar(); renderDashboard(); alert(`Dia ${iso} adiantado parcialmente para hoje.`); }

// -------- Notificações
function notifPermissionStatus(){ if(!("Notification" in window)) return "unsupported"; return Notification.permission; }
async function askNotificationPermission(){ if(!("Notification" in window)) return false; if(Notification.permission==="granted") return true; try{ const res=await Notification.requestPermission(); return res==="granted"; }catch{ return false; } }
function playAlertSound(){ if(!state.alerts.sound) return; try{ const el=$("#alert-sound"); if(el&&el.src){ el.play().catch(()=>{}); return; } const ctx=new (window.AudioContext||window.webkitAudioContext)(); const o=ctx.createOscillator(); const g=ctx.createGain(); o.type='sine'; o.frequency.value=880; o.connect(g); g.connect(ctx.destination); g.gain.setValueAtTime(0.001,ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.1,ctx.currentTime+0.02); g.gain.exponentialRampToValueAtTime(0.00001,ctx.currentTime+0.35); o.start(); o.stop(ctx.currentTime+0.36); }catch{} }
function showAlertNotification(title, body, url){ const can=("Notification" in window)&&Notification.permission==="granted"&&window.isSecureContext; if(can){ try{ const n=new Notification(title,{ body, icon:"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><text x='8' y='48' font-size='48'>📚</text></svg>" }); n.onclick=()=>{ if(url) window.open(url,"_blank"); window.focus(); }; }catch{} } else { const dash=$("#dashboard"); const div=document.createElement("div"); div.className="alert-banner"; div.textContent=`${title} — ${body}`; dash.prepend(div); setTimeout(()=>div.remove(),12000);} playAlertSound(); }
function notifyStudyForDate(iso){ const day=state.planByDate[iso]; if(!day||(day.minutesPlanned||0)===0) return; const topics=(day.topics||[]).map(t=>t.name).slice(0,3).join(" • "); const body=`${day.minutesPlanned} min • Meta: ${day.qTarget}q${topics?" • "+topics:""}`; showAlertNotification("Hora de estudar 📚", body, "https://www.qconcursos.com/questoes-de-concursos"); }
function scheduleAlerts(){ clearTimers(); if(!state.alerts.enabled) return; const statusEl=$("#notif-status"); if(statusEl){ const st=notifPermissionStatus(); statusEl.textContent=`🔔 Notificações: ${st==="granted"?"ativadas":(st==="denied"?"bloqueadas":"pendentes")}`; } const today=new Date(); const horizonDays=14; for(let i=0;i<=horizonDays;i++){ const d=addDays(today,i); const iso=toISO(d); const model=state.planByDate[iso]; if(!model) continue; if((model.minutesPlanned||0)<=0) continue; const dow=d.getDay(); const baseTime=(dow>=1&&dow<=5)?state.alerts.weekdayTime:state.alerts.weekendTime; const time=state.alerts.oneOff[iso]||baseTime; const when=atTimeOnDate(iso,time,state.alerts.leadMin); const delay=msUntil(when); if(delay<=0) continue; const id=setTimeout(()=>{ notifyStudyForDate(iso); }, delay); state._timers.push(id);} const midnight=new Date(); midnight.setHours(24,5,0,0); const id2=setTimeout(()=>{ scheduleAlerts(); autoApplyWeeklyReviewIfNeeded(); }, msUntil(midnight)); state._timers.push(id2); }

// -------- Google Calendar
function buildGoogleCalendarUrl(iso){ const day = state.planByDate[iso]; if(!day) return null; const date = fromISO(iso); const dow = date.getDay(); const baseTime = (dow>=1 && dow<=5) ? state.alerts.weekdayTime : state.alerts.weekendTime; const time = state.alerts.oneOff[iso] || baseTime || "19:00"; const start = atTimeOnDate(iso, time, 0); const end = new Date(start.getTime() + (day.minutesPlanned||60)*60000);
  const dates = `${toGCalDateTime(start)}/${toGCalDateTime(end)}`;
  const topics = (day.topics||[]).map(t=>t.name).join(', ');
  const text = encodeURIComponent(`Estudo — PF/PRF`);
  const details = encodeURIComponent(`Tópicos: ${topics}\nMeta de questões: ${day.qTarget}q\nUse seu cronograma local para registrar o que foi feito.`);
  const location = encodeURIComponent('Online');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${dates}&details=${details}&location=${location}`;
}

// -------- PDF Relatório Semanal
async function generateWeeklyPdf(start){ try{ const { jsPDF } = window.jspdf; const doc = new jsPDF('p','pt','a4'); const margin=36; const line=16; const w=doc.internal.pageSize.getWidth(); let y=margin;
  const wStart = startOfWeek(start); const wEnd = endOfWeek(start);
  // Cabeçalho
  doc.setFontSize(16); doc.text(`Relatório semanal — ${toISO(wStart)} a ${toISO(wEnd)}`, margin, y); y+=line;
  // KPIs
  let minDone=0, minPlan=0, qDone=0, qTarget=0; const accByDisc={}; const attemptsByDisc={};
  for(let d=new Date(wStart); d<=wEnd; d=addDays(d,1)){
    const day = state.planByDate[toISO(d)]; if(!day) continue; minDone+=day.minutesDone||0; minPlan+=day.minutesPlanned||0; qDone+=day.qDone||0; qTarget+=day.qTarget||0; (day.topics||[]).forEach(t=>{ const key=t.name; accByDisc[key] = (accByDisc[key]||{c:0,w:0}); accByDisc[key].c += Number(t.qCorrect||0); accByDisc[key].w += Number(t.qWrong||0); });
  }
  const hoursDone=(minDone/60).toFixed(1); const hoursPlan=(minPlan/60).toFixed(1); const kpi = `Horas: ${hoursDone}/${hoursPlan} • Questões: ${qDone}/${qTarget}`; doc.setFontSize(12); doc.text(kpi, margin, y); y+=line;
  // Gráficos
  const qs = $("#chart-qs"); const pie = $("#chart-pie");
  if(qs){ const img=qs.toDataURL('image/png',1.0); doc.addImage(img,'PNG', margin, y, w-2*margin, 140); y+=150; }
  if(pie){ const img2=pie.toDataURL('image/png',1.0); doc.addImage(img2,'PNG', margin, y, 200, 200); y+=210; }
  // Tabela por dia
  const rows=[]; for(let d=new Date(wStart); d<=wEnd; d=addDays(d,1)){
    const iso=toISO(d); const day=state.planByDate[iso]; if(!day) continue; const topics=(day.topics||[]).map(t=>t.name).slice(0,3).join(' • '); rows.push([ d.toLocaleDateString('pt-BR',{weekday:'short', day:'2-digit'}), `${day.minutesDone||0}/${day.minutesPlanned||0} min`, `${day.qDone||0}/${day.qTarget||0} q`, topics ]);
  }
  if(rows.length){ doc.autoTable({ startY: y, head: [['Dia','Tempo (feito/plan)','Questões (feitas/meta)','Tópicos']], body: rows, styles:{ fontSize:10 }, headStyles:{ fillColor:[56,189,248] } }); y = doc.lastAutoTable.finalY + 10; }
  // Acurácia por disciplina
  const rows2 = Object.entries(accByDisc).map(([disc, v])=>{ const tot=v.c+v.w; const acc= tot>0 ? Math.round((v.c/tot)*100) : 0; return [disc, `${v.c}`, `${v.w}`, `${acc}%`]; }).sort((a,b)=> parseInt(a[3]) - parseInt(b[3]) );
  if(rows2.length){ doc.autoTable({ startY: y, head: [['Disciplina','Acertos','Erros','Acurácia']], body: rows2, styles:{ fontSize:10 }, headStyles:{ fillColor:[34,197,94] } }); y = doc.lastAutoTable.finalY + 10; }
  // Recomendação
  const worst = rows2.slice(0,2).map(r=>r[0]).join(', ') || '—';
  doc.setFontSize(12); doc.text(`Foco recomendado para próxima semana: ${worst}`, margin, y);
  // Salvar
  doc.save(`relatorio_${toISO(wStart)}_a_${toISO(wEnd)}.pdf`);
}catch(e){ alert('Falha ao gerar PDF. Tente atualizar a página e gerar novamente.'); console.error(e); }}

// -------- Realoque futuros (sem mexer em revisões marcadas)
function reallocateFuture(fromIso){ const start=fromISO(fromIso); const end=fromISO(state.endDate); for(let d=new Date(start); d<=end; d=addDays(d,1)){ const iso=toISO(d); const day=state.planByDate[iso]; if(!day||(day.minutesPlanned||0)<=0) continue; const prev=day.topics||[]; const keepReviews=prev.filter(t=>t._review); const nonReviews=prev.filter(t=>!t._review); const targetNonRev=Math.max(0, day.minutesPlanned - keepReviews.reduce((a,t)=>a+t.minutes,0)); if(targetNonRev<=0){ day.topics=[...keepReviews]; continue; } const newNon=allocateTopicsForDay(targetNonRev); const map=Object.fromEntries(nonReviews.map(t=>[t.name, t])); const newNonMerged=newNon.map(t=>{ const old=map[t.name]; return old?{...t, links:old.links||[], done:old.done||false, qCorrect:old.qCorrect||0, qWrong:old.qWrong||0}:t; }); day.topics=[...keepReviews, ...newNonMerged]; }
  save(); }

// -------- Gráficos
let chartQs=null, chartPie=null;
function drawCharts(){ try{ const ctx=$("#chart-qs").getContext("2d"); if(chartQs) chartQs.destroy(); const labels=state.historyWeeks.map(w=>w.weekStart); const done=state.historyWeeks.map(w=>w.qDone); const goal=state.historyWeeks.map(w=>w.qTarget); chartQs=new Chart(ctx,{ type:"line", data:{ labels, datasets:[ {label:"Feitas", data:done, borderColor:"#22c55e", backgroundColor:"rgba(34,197,94,.2)", fill:true, tension:.3}, {label:"Meta", data:goal, borderColor:"#38bdf8", backgroundColor:"rgba(56,189,248,.15)", fill:false, tension:.3} ] }, options:{ responsive:true, plugins:{ legend:{ labels:{ color:"#e5e7eb" } } }, scales:{ x:{ ticks:{ color:"#cbd5e1" } }, y:{ ticks:{ color:"#cbd5e1" } } } }); }catch{}
  try{ const ctx2=$("#chart-pie").getContext("2d"); if(chartPie) chartPie.destroy(); const agg={}; Object.values(state.planByDate).forEach(day=>{ (day.topics||[]).forEach(t=>{ agg[t.name]=(agg[t.name]||0)+Math.min(t.minutes, day.minutesDone); }); }); const labels=Object.keys(agg); const data=Object.values(agg); chartPie=new Chart(ctx2,{ type:"doughnut", data:{ labels, datasets:[{ data, backgroundColor:labels.map((_,i)=>["#f59e0b","#22c55e","#38bdf8","#ef4444","#a78bfa","#34d399","#f472b6","#60a5fa"][i%8]) }] }, options:{ plugins:{ legend:{ labels:{ color:"#e5e7eb" } } } } ); }catch{} }

function updateHistoryWeekly(){ const out=[]; const today=new Date(); for(let i=11;i>=0;i--){ const ref=addDays(today,-7*i); const wStart=startOfWeek(ref); const wEnd=endOfWeek(ref); let qDone=0,qTarget=0; for(let d=new Date(wStart); d<=wEnd; d=addDays(d,1)){ const day=state.planByDate[toISO(d)]; if(!day) continue; qDone+=day.qDone||0; qTarget+=day.qTarget||0; } out.push({ weekStart: toISO(wStart).slice(5), qDone, qTarget }); } state.historyWeeks=out; }

// -------- Config UI
function bindConfig(){ const todayIso=toISO(new Date()); $("#cfg-start").value = state.startDate || todayIso; $("#cfg-duration-months").value=12; $("#cfg-weekday-min").value=state.weekdayMin; $("#cfg-weekend-total").value=state.weekendTotal; $("#cfg-weekend-split").checked=state.weekendSplit; $("#cfg-weekly-qs").value=state.weeklyQs; $("#cfg-replan-margin").value=state.replanMargin; $("#exam-pf").checked=state.exams.PF; $("#exam-prf").checked=state.exams.PRF;
  renderDiscList();
  $("#btn-generate").addEventListener("click",()=>{ state.startDate=$("#cfg-start").value||todayIso; state.weekdayMin=Number($("#cfg-weekday-min").value)||0; state.weekendTotal=Number($("#cfg-weekend-total").value)||0; state.weekendSplit=$("#cfg-weekend-split").checked; state.weeklyQs=Number($("#cfg-weekly-qs").value)||0; state.replanMargin=Number($("#cfg-replan-margin").value)||0; state.exams.PF=$("#exam-pf").checked; state.exams.PRF=$("#exam-prf").checked; generatePlan(); renderWeek(); renderCalendar(); renderDashboard(); scheduleAlerts(); alert("Cronograma gerado/atualizado com sucesso!"); });
  $("#disc-add").addEventListener("click",()=>{ const nm=$("#disc-name").value.trim(); const ex=$("#disc-exam").value; const wt=Number($("#disc-weight").value)||1; if(!nm) return; addDisc(nm,ex,wt); $("#disc-name").value=""; save(); renderDiscList(); });
  $("#cfg-carry-questions").checked=state.carryQuestions; $("#cfg-raise-daily").checked=state.raiseDaily; $("#cfg-carry-questions").addEventListener("change",e=>{ state.carryQuestions=e.target.checked; save(); }); $("#cfg-raise-daily").addEventListener("change",e=>{ state.raiseDaily=e.target.checked; save(); });
  // Alertas
  $("#cfg-alerts-enabled").checked=!!state.alerts.enabled; $("#cfg-alerts-weekday-time").value=state.alerts.weekdayTime||"19:00"; $("#cfg-alerts-weekend-time").value=state.alerts.weekendTime||"09:00"; $("#cfg-alerts-lead-min").value=state.alerts.leadMin??10; $("#cfg-alerts-sound").checked=!!state.alerts.sound;
  $("#cfg-alerts-enabled").addEventListener("change", async(e)=>{ state.alerts.enabled=e.target.checked; if(state.alerts.enabled){ const ok=await askNotificationPermission(); if(!ok) alert("Não foi possível ativar notificações. Verifique as permissões do navegador."); } save(); scheduleAlerts(); });
  $("#cfg-alerts-weekday-time").addEventListener("change", e=>{ state.alerts.weekdayTime=e.target.value||"19:00"; save(); scheduleAlerts(); }); $("#cfg-alerts-weekend-time").addEventListener("change", e=>{ state.alerts.weekendTime=e.target.value||"09:00"; save(); scheduleAlerts(); }); $("#cfg-alerts-lead-min").addEventListener("change", e=>{ state.alerts.leadMin=Math.max(0, parseInt(e.target.value||"0",10)); save(); scheduleAlerts(); }); $("#cfg-alerts-sound").addEventListener("change", e=>{ state.alerts.sound=!!e.target.checked; save(); });
  // Revisão semanal cfg
  $("#cfg-review-enabled").checked=!!state.review.enabled; $("#cfg-review-percent").value=state.review.percent||30; $("#cfg-review-n").value=state.review.n||2; const daysBox=$("#cfg-review-days"); $$("input[type=checkbox]", daysBox).forEach(chk=>{ chk.checked = state.review.days.includes(Number(chk.dataset.day)); chk.addEventListener('change',()=>{ const d=Number(chk.dataset.day); if(chk.checked){ if(!state.review.days.includes(d)) state.review.days.push(d);} else { state.review.days = state.review.days.filter(x=>x!==d);} save(); }); });
  $("#cfg-review-enabled").addEventListener('change',e=>{ state.review.enabled=!!e.target.checked; save(); }); $("#cfg-review-percent").addEventListener('change',e=>{ state.review.percent=Math.max(10, Math.min(50, Number(e.target.value)||30)); save(); }); $("#cfg-review-n").addEventListener('change',e=>{ state.review.n=Math.max(1, Math.min(4, Number(e.target.value)||2)); save(); });
  // Contas
  $("#cfg-alfacon-email").value = state.account.alfaconEmail||"";
  $("#cfg-qc-email").value = state.account.qcEmail||"";
  $("#cfg-copy-on-open").checked = !!state.account.copyOnOpen;
  $("#cfg-alfacon-email").addEventListener('change', e=>{ state.account.alfaconEmail = e.target.value.trim(); save(); });
  $("#cfg-qc-email").addEventListener('change', e=>{ state.account.qcEmail = e.target.value.trim(); save(); });
  $("#cfg-copy-on-open").addEventListener('change', e=>{ state.account.copyOnOpen = !!e.target.checked; save(); });
}

function renderDiscList(){ const box=$("#disc-list"); box.innerHTML=""; Object.entries(state.disciplines).forEach(([name,d])=>{ const row=document.createElement("div"); row.className="row wrap"; row.style.margin="6px 0"; const label=document.createElement("div"); label.textContent=`${name} (${d.exam})`; const inp=document.createElement("input"); inp.type="number"; inp.step="0.5"; inp.min="0.5"; inp.value=d.weight; inp.addEventListener('change',()=>{ d.weight=Number(inp.value)||d.weight; save(); }); const rm=document.createElement("button"); rm.textContent="Remover"; rm.addEventListener('click',()=>{ delete state.disciplines[name]; save(); renderDiscList(); }); row.appendChild(label); row.appendChild(inp); row.appendChild(rm); box.appendChild(row); }); }

// -------- Navegação / Eventos globais
function bindNav(){ $$(".tab-btn").forEach(btn=>{ btn.addEventListener('click',()=>{ $$(".tab-btn").forEach(b=>b.classList.remove("active")); $$(".tab-panel").forEach(p=>p.classList.remove("active")); btn.classList.add("active"); $("#"+btn.dataset.tab).classList.add("active"); if(btn.dataset.tab==="semana") renderWeek(); if(btn.dataset.tab==="calendario") renderCalendar(); if(btn.dataset.tab==="dashboard") renderDashboard(); const statusEl=$("#notif-status"); if(statusEl){ const st=notifPermissionStatus(); statusEl.textContent=`🔔 Notificações: ${st==="granted"?"ativadas":(st==="denied"?"bloqueadas":"pendentes")}`; } }); });
  $("#prev-week").addEventListener('click',()=>{ const curTitle=$("#week-title").textContent; const start=fromISO(curTitle.split(" ")[1]); renderWeek(addDays(start,-7)); });
  $("#next-week").addEventListener('click',()=>{ const curTitle=$("#week-title").textContent; const start=fromISO(curTitle.split(" ")[1]); renderWeek(addDays(start,7)); });
  $("#prev-month").addEventListener('click',()=>{ calRef=addDays(startOfMonth(calRef), -1); renderCalendar(); });
  $("#next-month").addEventListener('click',()=>{ calRef=addDays(endOfMonth(calRef), 1); renderCalendar(); });
  $("#btn-replan").addEventListener('click',()=>{ runReplan(new Date()); renderDashboard(); renderWeek(); renderCalendar(); });
  $("#btn-advance").addEventListener('click',()=>{ advanceOneDay(); });
  $("#btn-review-this-week").addEventListener('click',()=>{ const wk=startOfWeek(new Date()); applyReviewForWeek(wk); renderWeek(); renderCalendar(); renderDashboard(); alert("Revisão desta semana criada com base nas disciplinas mais difíceis."); });
  $("#btn-review-next-weeks").addEventListener('click',()=>{ const wk=startOfWeek(new Date()); applyReviewForNextWeeks(wk,4); });
  $("#btn-pdf-week").addEventListener('click',()=>{ generateWeeklyPdf(new Date()); });
  $("#btn-pdf-prev").addEventListener('click',()=>{ generateWeeklyPdf(addDays(startOfWeek(new Date()), -7)); });
  // backup
  $("#btn-export").addEventListener('click',()=>{ const data=new Blob([JSON.stringify(state,null,2)],{type:"application/json"}); const a=document.createElement("a"); a.href=URL.createObjectURL(data); a.download="cronograma_pf_prf_backup.json"; a.click(); });
  $("#file-import").addEventListener('change',(e)=>{ const f=e.target.files[0]; if(!f) return; const reader=new FileReader(); reader.onload=()=>{ try{ const obj=JSON.parse(reader.result); Object.assign(state,obj); save(); renderWeek(); renderCalendar(); renderDashboard(); bindConfig(); scheduleAlerts(); alert("Backup importado com sucesso!"); }catch{ alert("Falha ao importar JSON."); } }; reader.readAsText(f); });
  // atalhos com cópia de e-mail
  const qc = $("#link-qc"); qc.addEventListener('click', (ev)=>{ if(state.account.copyOnOpen && state.account.qcEmail){ try{ navigator.clipboard.writeText(state.account.qcEmail); }catch{} } });
  const af = $("#link-alfacon"); af.addEventListener('click', (ev)=>{ if(state.account.copyOnOpen && state.account.alfaconEmail){ try{ navigator.clipboard.writeText(state.account.alfaconEmail); }catch{} } });
}

// -------- Semana e Calendário
function renderDashboard(){ const wStart=startOfWeek(new Date()); const wEnd=endOfWeek(new Date()); let minDone=0,minPlan=0,qDone=0,qTarget=0; for(let d=new Date(wStart); d<=wEnd; d=addDays(d,1)){ const day=state.planByDate[toISO(d)]; if(!day) continue; minDone+=day.minutesDone||0; minPlan+=day.minutesPlanned||0; qDone+=day.qDone||0; qTarget+=day.qTarget||0; } const hoursDone=(minDone/60).toFixed(1); $("#hours-done-label").textContent=`${hoursDone}h`; $("#q-done-label").textContent=`${qDone} / ${qTarget}`; const hp=Math.min(100, Math.round((minDone/Math.max(1,minPlan))*100)); const qp=Math.min(100, Math.round((qDone/Math.max(1,qTarget))*100)); $("#hours-progress").style.width=hp+"%"; $("#q-progress").style.width=qp+"%"; updateHistoryWeekly(); drawCharts(); }

function renderWeek(refDate=new Date()){ const container=$("#week-list"); container.innerHTML=""; const wStart=startOfWeek(refDate); $("#week-title").textContent=`Semana ${toISO(wStart)} a ${toISO(addDays(wStart,6))}`; for(let d=new Date(wStart); d<=addDays(wStart,6); d=addDays(d,1)){ const iso=toISO(d); const model=state.planByDate[iso]||{minutesPlanned:0, topics:[], qTarget:0, qDone:0}; const tpl=$("#tpl-day-item").content.cloneNode(true); $(".day-title",tpl).textContent=d.toLocaleDateString("pt-BR",{weekday:"long", day:"2-digit", month:"2-digit"}); $(".day-sub",tpl).textContent=`${model.minutesPlanned} min planejados • ${model.topics.length} tópicos`; const chkAdv=$(".chk-advanced input",tpl); chkAdv.checked=!!model.advanced; chkAdv.addEventListener("change",()=>{ model.advanced=chkAdv.checked; save(); }); const chkDone=$(".chk-done input",tpl); chkDone.checked=!!model.done; chkDone.addEventListener("change",()=>{ model.done=chkDone.checked; if(chkDone.checked&&model.minutesDone<model.minutesPlanned){ model.minutesDone=model.minutesPlanned; } save(); renderDashboard(); renderCalendar(); });
    const topicsBox=$(".topics",tpl); topicsBox.innerHTML=""; (model.topics||[]).forEach((t)=>{ const ttpl=$("#tpl-topic").content.cloneNode(true); $(".topic-name",ttpl).textContent=t.name + (t.done?" ✓":""); $(".topic-min",ttpl).textContent=`${t.minutes} min`; const linksBox=$(".links",ttpl); linksBox.innerHTML=""; (t.links||[]).forEach((lk)=>{ const a=document.createElement("a"); a.href=lk.url; a.target="_blank"; a.className="pill small"; a.textContent=lk.title||lk.url; linksBox.appendChild(a); }); const inTitle=$(".in-link-title",ttpl); const inUrl=$(".in-link-url",ttpl); $(".btn-add-link",ttpl).addEventListener("click",()=>{ const title=inTitle.value.trim(); const url=inUrl.value.trim(); if(!url) return; t.links=t.links||[]; t.links.push({title:title||"Conteúdo", url}); inTitle.value=""; inUrl.value=""; save(); renderWeek(refDate);}); topicsBox.appendChild(ttpl); });
    const inQTarget=$(".in-q-target",tpl), inQDone=$(".in-q-done",tpl), inMinDone=$(".in-min-done",tpl); inQTarget.value=model.qTarget||0; inQDone.value=model.qDone||0; inMinDone.value=model.minutesDone||0; inQTarget.addEventListener("change",()=>{ model.qTarget=Number(inQTarget.value)||0; save(); renderDashboard(); renderCalendar(); }); inQDone.addEventListener("change",()=>{ model.qDone=Number(inQDone.value)||0; save(); renderDashboard(); renderCalendar(); }); inMinDone.addEventListener("change",()=>{ model.minutesDone=Number(inMinDone.value)||0; save(); renderDashboard(); renderCalendar(); });
    const btnRem=$(".btn-day-reminder",tpl); btnRem.addEventListener("click", async()=>{ if(!state.alerts.enabled){ alert("Ative as notificações nas Configurações para criar lembretes."); return;} const ok=await askNotificationPermission(); if(!ok){ alert("Notificações bloqueadas no navegador."); return;} const current=state.alerts.oneOff[iso]||((d.getDay()>=1&&d.getDay()<=5)?state.alerts.weekdayTime:state.alerts.weekendTime); const t=prompt(`Defina o horário para o lembrete em ${iso} (HH:MM)`, current); if(!t) return; if(!/^\d{2}:\d{2}$/.test(t)){ alert("Horário inválido. Use HH:MM."); return;} state.alerts.oneOff[iso]=t; save(); scheduleAlerts(); alert(`Lembrete agendado para ${iso} às ${t} (com antecedência de ${state.alerts.leadMin} min).`); });
    const btnGCal=$(".btn-gcal",tpl); btnGCal.addEventListener('click', ()=>{ const url=buildGoogleCalendarUrl(iso); if(!url){ alert('Sem dados para este dia.'); return;} window.open(url,'_blank'); });
    container.appendChild(tpl); state.planByDate[iso]=model; }
  save(); }

let calRef=new Date();
function renderCalendar(){ const grid=$("#calendar-grid"); grid.innerHTML=""; $("#month-title").textContent=calRef.toLocaleDateString("pt-BR",{month:"long", year:"numeric"}); const first=startOfMonth(calRef); const last=endOfMonth(calRef); const startCell=startOfWeek(first); const endCell=addDays(endOfWeek(last),0); for(let d=new Date(startCell); d<=endCell; d=addDays(d,1)){ const iso=toISO(d); const day=state.planByDate[iso]; const cell=document.createElement("div"); cell.className="cell"; cell.dataset.iso=iso; if(iso<toISO(new Date())) cell.classList.add("past"); if(iso===toISO(new Date())) cell.classList.add("today"); const dateEl=document.createElement("div"); dateEl.className="date"; dateEl.textContent=d.toLocaleDateString("pt-BR",{weekday:"short", day:"2-digit"}); cell.appendChild(dateEl); const mini=document.createElement("div"); mini.className="mini"; mini.textContent=day?`${day.minutesPlanned} min • alvo ${day.qTarget}q`:"—"; cell.appendChild(mini); const kpi=document.createElement("div"); kpi.className="kpi"; if(day){ const c1=document.createElement("span"); c1.className="chip"; c1.textContent=`Feitas: ${day.qDone}q`; kpi.appendChild(c1); const c2=document.createElement("span"); c2.className="chip"; c2.textContent=`Tempo: ${day.minutesDone}min`; kpi.appendChild(c2);} cell.appendChild(kpi); cell.addEventListener('click',()=>openDayModal(iso)); grid.appendChild(cell);} }

// -------- Modal do Dia
let currentModalIso=null;
function openDayModal(iso){ currentModalIso=iso; const modal=$("#day-modal"); const body=$("#day-modal-body"); const title=$("#day-modal-title"); const day=state.planByDate[iso]||{minutesPlanned:0, topics:[]}; title.textContent=`Estudos de ${new Date(iso).toLocaleDateString('pt-BR',{weekday:'long', day:'2-digit', month:'2-digit'})}`; body.innerHTML=''; if(!day.topics||!day.topics.length){ body.innerHTML='<p class="muted">Nenhum estudo planejado para este dia.</p>'; } else { day.topics.forEach((t,idx)=>{ const row=document.createElement('div'); row.className='topic-row'; const chk=document.createElement('input'); chk.type='checkbox'; chk.checked=!!t.done; chk.className='chk-topic-done'; chk.dataset.idx=idx; const nm=document.createElement('div'); nm.className='nm'; nm.textContent=t.name; const mins=document.createElement('div'); mins.className='mins'; mins.textContent=`${t.minutes} min`; const ac=document.createElement('input'); ac.type='number'; ac.min='0'; ac.placeholder='Acertos'; ac.value=Number(t.qCorrect||0); ac.className='in-correct'; ac.dataset.idx=idx; const wr=document.createElement('input'); wr.type='number'; wr.min='0'; wr.placeholder='Erros'; wr.value=Number(t.qWrong||0); wr.className='in-wrong'; wr.dataset.idx=idx; row.appendChild(chk); row.appendChild(nm); row.appendChild(mins); row.appendChild(ac); row.appendChild(wr); body.appendChild(row); }); }
  updateModalSummary(); $("#day-modal-gcal").onclick = ()=>{ const url=buildGoogleCalendarUrl(iso); if(!url){ alert('Sem dados para este dia.'); return;} window.open(url,'_blank'); };
  modal.classList.remove('hidden'); modal.setAttribute('aria-hidden','false'); }
function updateModalSummary(){ if(!currentModalIso) return; const day=state.planByDate[currentModalIso]; if(!day) return; let totalC=0,totalW=0,doneTopics=0; (day.topics||[]).forEach(t=>{ totalC+=Number(t.qCorrect||0); totalW+=Number(t.qWrong||0); doneTopics+=t.done?1:0; }); const tot=totalC+totalW; const acc=tot>0?Math.round((totalC/tot)*100):0; $("#day-modal-summary").textContent=`Tópicos concluídos: ${doneTopics}/${day.topics.length} • Questões: ${totalC} certo(s), ${totalW} erro(s) • Acerto: ${acc}%`; }
function closeDayModal(){ const modal=$("#day-modal"); modal.classList.add('hidden'); modal.setAttribute('aria-hidden','true'); currentModalIso=null; }
function bindModalEvents(){ $("#day-modal-close").addEventListener('click', closeDayModal); $("#day-modal").addEventListener('click',(e)=>{ if(e.target.id==='day-modal') closeDayModal(); }); $("#day-modal-save").addEventListener('click',()=>{ if(!currentModalIso) return; const day=state.planByDate[currentModalIso]; if(!day) return; $$(".topic-row").forEach(row=>{ const idx=Number(row.querySelector('.chk-topic-done')?.dataset.idx||0); const chk=row.querySelector('.chk-topic-done'); const ac=row.querySelector('.in-correct'); const wr=row.querySelector('.in-wrong'); const t=day.topics[idx]; if(!t) return; t.done=!!chk.checked; t.qCorrect=Math.max(0, parseInt(ac.value||'0',10)); t.qWrong=Math.max(0, parseInt(wr.value||'0',10)); }); day.minutesDone=(day.topics||[]).filter(t=>t.done).reduce((a,t)=>a+(t.minutes||0),0); day.qDone=(day.topics||[]).reduce((a,t)=>a+((Number(t.qCorrect||0)+Number(t.qWrong||0))||0),0); day.done=(day.topics||[]).every(t=>t.done); save(); const nextIso=toISO(addDays(fromISO(currentModalIso),1)); reallocateFuture(nextIso); renderDashboard(); renderCalendar(); renderWeek(); closeDayModal(); }); }

// -------- Init
(function init(){ const ok=load(); ensureDefaultDisciplines(); bindNav(); bindConfig(); bindModalEvents(); if(!ok){ state.startDate=toISO(new Date()); generatePlan(); }
  renderWeek(); renderCalendar(); renderDashboard(); scheduleAlerts(); autoApplyWeeklyReviewIfNeeded(); document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'){ scheduleAlerts(); } }); window.addEventListener('focus', scheduleAlerts); })();
