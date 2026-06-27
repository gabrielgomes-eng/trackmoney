/* ═══════════════════════════════════════════════════════
   FinançasPro — script.js  (Firebase Firestore + Auth)
   ═══════════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════════════
   FIREBASE REFS  (preenchidos após login)
   ══════════════════════════════════════ */
let db   = null;   // Firestore instance
let auth = null;   // Auth instance
let uid  = null;   // ID do usuário logado

// Retorna referência para subcoleção do usuário
function col(name) {
  return db.collection('users').doc(uid).collection(name);
}

// Retorna referência para documento de configuração do usuário
function userDoc() {
  return db.collection('users').doc(uid);
}

/* ══════════════════════════════════════
   CONSTANTES
   ══════════════════════════════════════ */
const CATEGORIAS_PADRAO = ['Alimentação','Transporte','Moradia','Saúde','Educação','Lazer','Investimentos','Outros'];
const STATUS_PAGO = 'pago';
const STATUS_PENDENTE = 'pendente';

/* ══════════════════════════════════════
   STATE  (cache local — espelho do Firestore)
   ══════════════════════════════════════ */
const STATE = {
  receitas:     [],
  despesas:     [],
  metas:        [],
  recorrentes:  [],
  categorias:   [...CATEGORIAS_PADRAO],
  metaEconomia: 0,
  currentMonth: new Date().getMonth(),
  currentYear:  new Date().getFullYear(),
  sort:         { field: null, asc: true },
  theme:        'light',
  charts:       {},
  listeners:    []   // unsubscribe functions
};

/* ══════════════════════════════════════
   UTILITIES
   ══════════════════════════════════════ */
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function fmt(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function monthLabel(month, year) {
  return new Date(year, month, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

function filterByMonth(arr) {
  return arr.filter(item => {
    if (!item.data) return false;
    const d = new Date(item.data + 'T12:00:00');
    return d.getMonth() === STATE.currentMonth && d.getFullYear() === STATE.currentYear;
  });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Redimensiona e comprime uma imagem (File) para um base64 JPEG pequeno,
// evitando ultrapassar o limite de 1MB por documento no Firestore.
function resizeImageToBase64(file, maxW = 200, maxH = 200, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const ratio = Math.min(maxW / width, maxH / height, 1);
        width  = Math.round(width * ratio);
        height = Math.round(height * ratio);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);

        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Não foi possível carregar a imagem.'));
      img.src = ev.target.result;
    };
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}

/* ══════════════════════════════════════
   TOAST
   ══════════════════════════════════════ */
function toast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: 'mdi:check-circle', error: 'mdi:alert-circle', warning: 'mdi:alert', info: 'mdi:information' };
  el.innerHTML = `<iconify-icon icon="${icons[type]||icons.info}" width="18"></iconify-icon> ${msg}`;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 320); }, 3200);
}

/* ══════════════════════════════════════
   SYNC INDICATOR
   ══════════════════════════════════════ */
function showSync() {
  let dot = document.getElementById('syncDot');
  if (!dot) {
    dot = document.createElement('span');
    dot.id = 'syncDot';
    dot.className = 'sync-dot';
    dot.title = 'Sincronizando...';
    document.getElementById('topbarTitle').appendChild(dot);
  }
}

function hideSync() {
  const dot = document.getElementById('syncDot');
  if (dot) dot.remove();
}

/* ══════════════════════════════════════
   FIRESTORE — LISTENERS EM TEMPO REAL
   ══════════════════════════════════════ */

// Desinscreve todos os listeners anteriores (ex: ao trocar usuário)
function detachListeners() {
  STATE.listeners.forEach(unsub => unsub());
  STATE.listeners = [];
}

function attachListeners() {
  detachListeners();

  // Receitas
  const unsubRec = col('receitas').onSnapshot(snap => {
    STATE.receitas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    refreshCurrentPage();
    hideSync();
  }, err => { console.error('Receitas:', err); hideSync(); });

  // Despesas
  const unsubDesp = col('despesas').onSnapshot(snap => {
    STATE.despesas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    refreshCurrentPage();
    updateContasBadge();
    hideSync();
  }, err => { console.error('Despesas:', err); hideSync(); });

  // Metas
  const unsubMeta = col('metas').onSnapshot(snap => {
    STATE.metas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    refreshCurrentPage();
    hideSync();
  }, err => { console.error('Metas:', err); hideSync(); });

  // Recorrentes (entradas/saídas que se repetem todo mês)
  const unsubRecorr = col('recorrentes').onSnapshot(snap => {
    STATE.recorrentes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    refreshCurrentPage();
    hideSync();
    // Gera automaticamente os lançamentos do mês que ainda não existem
    processarTodasRecorrencias().then(() => verificarLembretesRecorrentes());
  }, err => { console.error('Recorrentes:', err); hideSync(); });

  // Config do usuário (categorias, metaEconomia, tema)
  const unsubCfg = userDoc().onSnapshot(snap => {
    if (snap.exists) {
      const data = snap.data();
      if (data.categorias)   STATE.categorias   = data.categorias;
      if (data.metaEconomia !== undefined) STATE.metaEconomia = data.metaEconomia;
      if (data.theme)        { STATE.theme = data.theme; applyTheme(data.theme); }
    }
    refreshCurrentPage();
    hideSync();
  }, err => { console.error('Config:', err); hideSync(); });

  STATE.listeners.push(unsubRec, unsubDesp, unsubMeta, unsubRecorr, unsubCfg);
}

/* ══════════════════════════════════════
   FIRESTORE — WRITE HELPERS
   ══════════════════════════════════════ */

async function fbAdd(colName, data) {
  showSync();
  const { id, ...rest } = data;
  await col(colName).doc(id).set(rest);
}

async function fbUpdate(colName, data) {
  showSync();
  const { id, ...rest } = data;
  await col(colName).doc(id).update(rest);
}

async function fbDelete(colName, id) {
  showSync();
  await col(colName).doc(id).delete();
}

async function fbSaveConfig() {
  showSync();
  await userDoc().set({
    categorias:   STATE.categorias,
    metaEconomia: STATE.metaEconomia,
    theme:        STATE.theme
  }, { merge: true });
}

/* ══════════════════════════════════════
   AUTH
   ══════════════════════════════════════ */
function initAuth() {
  auth = firebase.auth();
  db   = firebase.firestore();

  auth.onAuthStateChanged(user => {
    if (user) {
      onLogin(user);
    } else {
      onLogout();
    }
  });

  document.getElementById('btnLoginGoogle').addEventListener('click', loginGoogle);
  document.getElementById('btnLogout')?.addEventListener('click', logout);
}

function loginGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  const loadingEl = document.getElementById('loginLoading');
  const errorEl   = document.getElementById('loginError');
  loadingEl.style.display = 'flex';
  errorEl.textContent = '';

  auth.signInWithPopup(provider).catch(err => {
    loadingEl.style.display = 'none';
    errorEl.textContent = 'Erro ao entrar: ' + err.message;
  });
}

function logout() {
  detachListeners();
  auth.signOut();
}

function onLogin(user) {
  uid = user.uid;

  // Esconde login e mostra app
  document.getElementById('loginOverlay').classList.add('hidden');
  document.body.classList.add('logged-in');

  // Popula perfil
  const chip = document.getElementById('userChip');
  if (chip) {
    chip.style.display = 'flex';
    const photoURL = user.photoURL || '';
    const displayName = user.displayName || user.email;
    const firstName = displayName.split(' ')[0];

    document.getElementById('userAvatar').src        = photoURL;
    document.getElementById('userName').textContent  = firstName;
    document.getElementById('profileAvatarBig').src  = photoURL;
    document.getElementById('profileName').textContent  = displayName;
    document.getElementById('profileEmail').textContent = user.email;
  }

  // Insere na topbar
  const topbar = document.querySelector('.topbar');
  if (topbar && chip && !topbar.contains(chip)) topbar.appendChild(chip);

  // Profile dropdown — registra após inserir no DOM
  document.getElementById('profileBtn').onclick = (e) => {
    e.stopPropagation();
    document.getElementById('userChip').classList.toggle('open');
  };

  document.getElementById('btnLogout').onclick = logout;

  document.getElementById('btnEditName').onclick = () => {
    document.getElementById('inputEditName').value = document.getElementById('profileName').textContent;
    document.getElementById('userChip').classList.remove('open');
    openModal('modalEditName');
  };

  document.getElementById('formEditName').onsubmit = async (e) => {
    e.preventDefault();
    const newName = document.getElementById('inputEditName').value.trim();
    if (!newName) return;
    try {
      await firebase.auth().currentUser.updateProfile({ displayName: newName });
      document.getElementById('profileName').textContent = newName;
      document.getElementById('userName').textContent    = newName.split(' ')[0];
      closeModal('modalEditName');
      toast('Nome atualizado!');
    } catch(err) { toast('Erro: ' + err.message, 'error'); }
  };

  document.getElementById('btnChangePhoto').onclick = () => {
    document.getElementById('userChip').classList.remove('open');
    document.getElementById('inputChangePhoto').click();
  };

  document.getElementById('inputChangePhoto').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const base64 = await resizeImageToBase64(file, 200, 200);
      await userDoc().set({ photoURL: base64 }, { merge: true });
      document.getElementById('userAvatar').src       = base64;
      document.getElementById('profileAvatarBig').src = base64;
      toast('Foto atualizada!');
    } catch(err) { toast('Erro ao salvar foto: ' + err.message, 'error'); }
  };

  attachListeners();
  // Load custom photo if saved
  userDoc().get().then(snap => {
    if (snap.exists && snap.data().photoURL) {
      const url = snap.data().photoURL;
      document.getElementById('userAvatar').src       = url;
      document.getElementById('profileAvatarBig').src = url;
    }
  });
  populateCategorySelects();
  updateMonthLabel();
  navigate('dashboard');
}

function onLogout() {
  uid = null;
  document.getElementById('loginOverlay').classList.remove('hidden');
  document.getElementById('loginLoading').style.display = 'none';
  document.body.classList.remove('logged-in');
  const chip = document.getElementById('userChip');
  if (chip) { chip.style.display = 'none'; chip.classList.remove('open'); }

  // Limpa state
  STATE.receitas = [];
  STATE.despesas = [];
  STATE.metas    = [];
}

/* ══════════════════════════════════════
   NAVIGATION
   ══════════════════════════════════════ */
function navigate(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const page = document.getElementById(`page-${pageId}`);
  if (page) page.classList.add('active');

  const navItem = document.querySelector(`.nav-item[data-page="${pageId}"]`);
  if (navItem) navItem.classList.add('active');

  const titles = {
    dashboard:'Dashboard', lancamentos:'Lançamentos',
    relatorios:'Relatórios', metas:'Metas Financeiras',
    contas:'Contas a Pagar', configuracoes:'Configurações'
  };
  document.getElementById('topbarTitle').textContent = titles[pageId] || pageId;

  if (pageId === 'dashboard')     renderDashboard();
  if (pageId === 'lancamentos')   renderLancamentos();
  if (pageId === 'relatorios')    renderRelatorios();
  if (pageId === 'metas')         renderMetas();
  if (pageId === 'contas')        renderContas();
  if (pageId === 'configuracoes') renderConfiguracoes();

  if (window.innerWidth <= 768) closeSidebar();
}

function refreshCurrentPage() {
  const active = document.querySelector('.page.active');
  if (!active) return;
  navigate(active.id.replace('page-', ''));
}

/* ══════════════════════════════════════
   SIDEBAR
   ══════════════════════════════════════ */
function openSidebar()  { document.getElementById('sidebar').classList.add('open'); document.getElementById('overlay').classList.add('active'); }
function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('overlay').classList.remove('active'); }

/* ══════════════════════════════════════
   MODALS
   ══════════════════════════════════════ */
function openModal(id)  { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

/* ══════════════════════════════════════
   THEME
   ══════════════════════════════════════ */
function applyTheme(theme) {
  STATE.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon  = document.getElementById('themeIcon');
  const label = document.getElementById('themeLabel');
  if (theme === 'dark') { icon.setAttribute('icon','mdi:white-balance-sunny'); label.textContent = 'Modo Claro'; }
  else                  { icon.setAttribute('icon','mdi:weather-night');        label.textContent = 'Modo Escuro'; }
  renderChartDashboard();
}

/* ══════════════════════════════════════
   CATEGORY SELECTS
   ══════════════════════════════════════ */
function populateCategorySelects() {
  ['lancCategoria','filtroCategoriaLancamento'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const isFilter = id.startsWith('filtro');
    const val = el.value;
    el.innerHTML = isFilter ? '<option value="">Todas as categorias</option>' : '<option value="">Selecione...</option>';
    STATE.categorias.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat; opt.textContent = cat;
      el.appendChild(opt);
    });
    if (val) el.value = val;
  });
}

function updateMonthLabel() {
  document.getElementById('currentMonthLabel').textContent = capitalize(monthLabel(STATE.currentMonth, STATE.currentYear));
}

/* ══════════════════════════════════════
   DASHBOARD
   ══════════════════════════════════════ */
function renderDashboard() {
  const rec  = filterByMonth(STATE.receitas);
  const desp = filterByMonth(STATE.despesas);

  // Inclui recorrentes nos totais
  const recorrentesDoMes = STATE.recorrentes.map(r => recorrenteParaItem(r, STATE.currentMonth, STATE.currentYear));
  const totalRec  = rec.reduce((a,r)=>a+r.valor,0) + recorrentesDoMes.filter(r=>r.tipo==='receita').reduce((a,r)=>a+r.valor,0);
  const totalDesp = desp.reduce((a,d)=>a+d.valor,0) + recorrentesDoMes.filter(r=>r.tipo==='despesa').reduce((a,r)=>a+r.valor,0);
  const economiaMes = totalRec - totalDesp;

  // Saldo Atual = saldo acumulado de TODOS os lançamentos (não só do mês selecionado)
  const saldoGeral = STATE.receitas.reduce((a,r)=>a+r.valor,0) - STATE.despesas.reduce((a,d)=>a+d.valor,0);

  document.getElementById('saldoAtual').textContent    = fmt(saldoGeral);
  document.getElementById('totalReceitas').textContent = fmt(totalRec);
  document.getElementById('totalDespesas').textContent = fmt(totalDesp);
  document.getElementById('economia').textContent      = fmt(economiaMes);
  document.getElementById('totalLancamentos').textContent = rec.length + desp.length;

  document.getElementById('saldoAtual').style.color = saldoGeral < 0 ? 'var(--danger)' : saldoGeral === 0 ? 'var(--text-primary)' : 'var(--accent)';

  renderChartDashboard();
  renderRecentTransactions([...rec, ...desp, ...recorrentesDoMes]);
  updateContasBadge();
}

function renderRecentTransactions(all) {
  const sorted = [...all].sort((a,b)=>new Date(b.data)-new Date(a.data)).slice(0,8);
  const el = document.getElementById('recentTransactions');
  if (!sorted.length) {
    el.innerHTML = `<div class="empty-state"><iconify-icon icon="mdi:receipt-text-outline" width="48"></iconify-icon><p>Nenhum lançamento ainda.<br>Comece adicionando uma receita ou despesa.</p></div>`;
    return;
  }
  el.innerHTML = sorted.map(item => {
    const isRec = STATE.receitas.some(r=>r.id===item.id);
    return `<div class="transaction-item">
      <div class="tx-icon ${isRec?'income':'expense'}"><iconify-icon icon="${isRec?'mdi:arrow-down':'mdi:arrow-up'}" width="16"></iconify-icon></div>
      <div class="tx-info">
        <div class="tx-desc">${item.descricao}</div>
        <div class="tx-meta">${item.categoria} · ${fmtDate(item.data)}</div>
      </div>
      <div class="tx-amount ${isRec?'income':'expense'}">${isRec?'+':'-'}${fmt(item.valor)}</div>
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════
   CHARTS
   ══════════════════════════════════════ */
function getChartColors() {
  const dark = document.documentElement.getAttribute('data-theme')==='dark';
  return { grid: dark?'rgba(255,255,255,.06)':'rgba(0,0,0,.06)', text: dark?'#94a3b8':'#64748b', bg: dark?'#1e293b':'#ffffff' };
}

const PALETTE = ['#10b981','#3b82f6','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#64748b','#ec4899','#14b8a6'];

function destroyChart(id) { if (STATE.charts[id]) { STATE.charts[id].destroy(); delete STATE.charts[id]; } }

function renderChartDashboard() {
  const desp = filterByMonth(STATE.despesas);
  const col  = getChartColors();

  destroyChart('pizza');
  const ctxP = document.getElementById('chartPizza')?.getContext('2d');
  if (ctxP) {
    const catMap = {};
    desp.forEach(d => { catMap[d.categoria]=(catMap[d.categoria]||0)+d.valor; });
    const labels = Object.keys(catMap), data = Object.values(catMap);
    if (labels.length) {
      STATE.charts.pizza = new Chart(ctxP, {
        type:'doughnut', data:{ labels, datasets:[{ data, backgroundColor:PALETTE, borderWidth:2, borderColor:col.bg }] },
        options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'right', labels:{ color:col.text, font:{size:12}, boxWidth:12 }}, tooltip:{ callbacks:{ label:c=>` ${c.label}: ${fmt(c.parsed)}`}}}}
      });
    }
  }

  destroyChart('comparativo');
  const ctxC = document.getElementById('chartComparativo')?.getContext('2d');
  if (ctxC) {
    const months=[],recData=[],despData=[];
    for (let i=5;i>=0;i--) {
      let m=STATE.currentMonth-i, y=STATE.currentYear;
      if(m<0){m+=12;y--;}
      months.push(new Date(y,m,1).toLocaleDateString('pt-BR',{month:'short'}));
      recData.push(STATE.receitas.filter(r=>{const d=new Date(r.data+'T12:00:00');return d.getMonth()===m&&d.getFullYear()===y;}).reduce((a,r)=>a+r.valor,0));
      despData.push(STATE.despesas.filter(d=>{const dt=new Date(d.data+'T12:00:00');return dt.getMonth()===m&&dt.getFullYear()===y;}).reduce((a,d)=>a+d.valor,0));
    }
    STATE.charts.comparativo = new Chart(ctxC, {
      type:'bar', data:{ labels:months, datasets:[
        {label:'Receitas', data:recData,  backgroundColor:'rgba(16,185,129,.7)', borderRadius:6},
        {label:'Despesas', data:despData, backgroundColor:'rgba(239,68,68,.7)',  borderRadius:6}
      ]},
      options:{ responsive:true, maintainAspectRatio:false, scales:{ x:{grid:{color:col.grid},ticks:{color:col.text}}, y:{grid:{color:col.grid},ticks:{color:col.text,callback:v=>'R$'+(v/1000).toFixed(0)+'k'}}}, plugins:{ legend:{labels:{color:col.text}}, tooltip:{callbacks:{label:c=>` ${c.dataset.label}: ${fmt(c.parsed.y)}` }}}}
    });
  }
}

function renderChartRelatorios() {
  const col = getChartColors();

  destroyChart('mensal');
  const ctxM = document.getElementById('chartMensal')?.getContext('2d');
  if (ctxM) {
    const months=[],recD=[],despD=[];
    for(let i=11;i>=0;i--){
      let m=STATE.currentMonth-i,y=STATE.currentYear;
      if(m<0){m+=12;y--;}
      months.push(new Date(y,m,1).toLocaleDateString('pt-BR',{month:'short',year:'2-digit'}));
      recD.push(STATE.receitas.filter(r=>{const d=new Date(r.data+'T12:00:00');return d.getMonth()===m&&d.getFullYear()===y;}).reduce((a,r)=>a+r.valor,0));
      despD.push(STATE.despesas.filter(d=>{const dt=new Date(d.data+'T12:00:00');return dt.getMonth()===m&&dt.getFullYear()===y;}).reduce((a,d)=>a+d.valor,0));
    }
    STATE.charts.mensal = new Chart(ctxM, {
      type:'bar', data:{labels:months,datasets:[{label:'Receitas',data:recD,backgroundColor:'rgba(16,185,129,.7)',borderRadius:6},{label:'Despesas',data:despD,backgroundColor:'rgba(239,68,68,.7)',borderRadius:6}]},
      options:{responsive:true,maintainAspectRatio:false,scales:{x:{grid:{color:col.grid},ticks:{color:col.text}},y:{grid:{color:col.grid},ticks:{color:col.text,callback:v=>'R$'+(v/1000).toFixed(0)+'k'}}},plugins:{legend:{labels:{color:col.text}},tooltip:{callbacks:{label:c=>` ${c.dataset.label}: ${fmt(c.parsed.y)}`}}}}
    });
  }

  destroyChart('recCat');
  const ctxR = document.getElementById('chartReceitasCategoria')?.getContext('2d');
  if (ctxR) {
    const recMap={};
    filterByMonth(STATE.receitas).forEach(r=>{recMap[r.categoria]=(recMap[r.categoria]||0)+r.valor;});
    const rl=Object.keys(recMap),rv=Object.values(recMap);
    if(rl.length){
      STATE.charts.recCat = new Chart(ctxR,{type:'pie',data:{labels:rl,datasets:[{data:rv,backgroundColor:PALETTE,borderColor:col.bg,borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{color:col.text,font:{size:11},boxWidth:12}},tooltip:{callbacks:{label:c=>` ${c.label}: ${fmt(c.parsed)}`}}}}});
    }
  }

  renderCategoryTable('tabelaGastosCategoria',  filterByMonth(STATE.despesas), '#ef4444');
  renderCategoryTable('tabelaReceitasCategoria', filterByMonth(STATE.receitas), '#10b981');
}

function renderCategoryTable(elId, items, color) {
  const el = document.getElementById(elId);
  if (!el) return;
  const map={};
  items.forEach(i=>{map[i.categoria]=(map[i.categoria]||0)+i.valor;});
  const total=Object.values(map).reduce((a,v)=>a+v,0);
  const sorted=Object.entries(map).sort((a,b)=>b[1]-a[1]);
  if(!sorted.length){el.innerHTML='<p class="empty-msg">Sem dados para o período</p>';return;}
  el.innerHTML=sorted.map(([cat,val])=>{
    const pct=total?(val/total*100).toFixed(1):0;
    return `<div class="cat-row"><span class="cat-label">${cat}</span><div class="cat-bar-wrap"><div class="cat-bar-bg"><div class="cat-bar-fill" style="width:${pct}%;background:${color}"></div></div></div><span class="cat-value">${fmt(val)}</span></div>`;
  }).join('');
}

/* ══════════════════════════════════════
   LANÇAMENTOS (Receitas + Despesas unificados)
   ══════════════════════════════════════ */
function renderLancamentos() {
  populateCategorySelects();
  const search = (document.getElementById('filtroLancamentos')?.value || '').toLowerCase();
  const tipo   = document.getElementById('filtroTipoLancamento')?.value || '';
  const cat    = document.getElementById('filtroCategoriaLancamento')?.value || '';
  const status = document.getElementById('filtroStatusLancamento')?.value || '';

  // Inclui recorrentes como itens virtuais do mês atual (sem criar nada no Firestore)
  const recorrentesDoMes = STATE.recorrentes.map(rec =>
    recorrenteParaItem(rec, STATE.currentMonth, STATE.currentYear)
  );

  // Junta receitas, despesas e recorrentes num único array
  const receitasComTipo = filterByMonth(STATE.receitas).map(r => ({ ...r, tipo: 'receita' }));
  const despesasComTipo = filterByMonth(STATE.despesas).map(d => ({ ...d, tipo: 'despesa' }));
  let items = [...receitasComTipo, ...despesasComTipo, ...recorrentesDoMes].filter(item =>
    (!search || item.descricao.toLowerCase().includes(search)) &&
    (!tipo || item.tipo === tipo) &&
    (!cat || item.categoria === cat) &&
    (!status || item.status === status)
  );

  if (STATE.sort.field) items = sortItems(items, STATE.sort.field, STATE.sort.asc);
  else items.sort((a, b) => new Date(b.data) - new Date(a.data));

  const tbody = document.getElementById('bodyLancamentos');
  if (!items.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7"><div class="empty-state"><iconify-icon icon="mdi:swap-vertical" width="40"></iconify-icon><p>Nenhum lançamento encontrado</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(item => {
    const isReceita = item.tipo === 'receita';
    const editFn = isReceita ? 'editReceita' : 'editDespesa';
    const delTipo = isReceita ? 'receita' : 'despesa';
    const valorColor = isReceita ? 'var(--accent)' : 'var(--danger)';
    const valorSinal = isReceita ? '+' : '-';

    const statusCell = isReceita
      ? '<span class="muted-text" style="margin:0">—</span>'
      : `<span class="chip chip-${item.status}">${item.status === STATUS_PAGO ? 'Pago' : 'Pendente'}</span>`;

    const payBtn = (!isReceita && item.status === STATUS_PENDENTE)
      ? `<button class="action-btn pay" title="Marcar pago" onclick="marcarPago('${item.id}')"><iconify-icon icon="mdi:check" width="17"></iconify-icon></button>`
      : '';

    return `<tr>
      <td data-label="Descrição">${item.descricao}</td>
      <td data-label="Tipo"><span class="chip chip-${isReceita ? 'income' : 'expense'}">${isReceita ? 'Entrada' : 'Saída'}</span></td>
      <td data-label="Valor" style="color:${valorColor};font-weight:700">${valorSinal} ${fmt(item.valor)}</td>
      <td data-label="Data">${fmtDate(item.data)}</td>
      <td data-label="Categoria"><span class="chip chip-${isReceita ? 'income' : 'expense'}">${item.categoria}</span></td>
      <td data-label="Status">${statusCell}</td>
      <td>${payBtn}<button class="action-btn edit" onclick="${editFn}('${item.id}')"><iconify-icon icon="mdi:pencil-outline" width="17"></iconify-icon></button><button class="action-btn del" onclick="confirmDelete('${delTipo}','${item.id}')"><iconify-icon icon="mdi:trash-can-outline" width="17"></iconify-icon></button></td>
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════
   MODAL UNIFICADO: NOVO LANÇAMENTO
   ══════════════════════════════════════ */
function setTipoLancamento(tipo) {
  document.getElementById('btnTipoEntrada').classList.toggle('active', tipo === 'receita');
  document.getElementById('btnTipoSaida').classList.toggle('active', tipo === 'despesa');
  document.getElementById('formLancamento').dataset.tipo = tipo;

  document.getElementById('lancStatusField').style.display = tipo === 'despesa' ? '' : 'none';

  document.getElementById('lancRecorrenteLabel').textContent = tipo === 'despesa'
    ? 'É uma dívida ou conta fixa que se repete todo mês?'
    : 'Essa entrada se repete todo mês? (ex: salário)';
}

function toggleRecorrenteFields() {
  const checked = document.getElementById('lancRecorrente').checked;
  document.getElementById('recorrenteFields').style.display = checked ? '' : 'none';
  document.getElementById('lancDiaMes').required = checked;
  // Quando é recorrente, a data exata perde sentido (o dia do mês manda) — mas mantemos
  // a data como referência da 1ª ocorrência.
}

function openLancamentoModal(item = null, tipoForced = null) {
  const form = document.getElementById('formLancamento');
  form.reset();
  document.getElementById('lancId').value = '';
  document.getElementById('lancRecorrenteId').value = '';
  document.getElementById('lancData').value = today();
  document.getElementById('recorrenteFields').style.display = 'none';
  document.getElementById('lancDiaMes').required = false;

  const tipo = tipoForced || (item && item.tipo) || 'receita';
  setTipoLancamento(tipo);

  if (item) {
    document.getElementById('modalLancamentoTitulo').textContent = 'Editar Lançamento';
    document.getElementById('lancId').value = item.id;
    document.getElementById('lancDescricao').value = item.descricao;
    document.getElementById('lancValor').value = item.valor;
    document.getElementById('lancData').value = item.data;
    document.getElementById('lancCategoria').value = item.categoria;
    if (tipo === 'despesa') {
      document.querySelector(`input[name="lancStatus"][value="${item.status || STATUS_PENDENTE}"]`).checked = true;
    }
    
    // CORREÇÃO 2: BLOQUEIA a troca de tipo na edição
    document.getElementById('btnTipoEntrada').style.pointerEvents = 'none';
    document.getElementById('btnTipoSaida').style.pointerEvents = 'none';
    document.getElementById('btnTipoEntrada').style.opacity = '0.5';
    document.getElementById('btnTipoSaida').style.opacity = '0.5';
  } else {
    document.getElementById('modalLancamentoTitulo').textContent = 'Novo Lançamento';
    document.querySelector('input[name="lancStatus"][value="pendente"]').checked = true;
    
    // CORREÇÃO 2: LIBERA a troca de tipo para novos lançamentos
    document.getElementById('btnTipoEntrada').style.pointerEvents = 'auto';
    document.getElementById('btnTipoSaida').style.pointerEvents = 'auto';
    document.getElementById('btnTipoEntrada').style.opacity = '1';
    document.getElementById('btnTipoSaida').style.opacity = '1';
  }

  openModal('modalLancamento');
}

function editReceita(id){const r=STATE.receitas.find(r=>r.id===id);if(r)openLancamentoModal(r,'receita');}
function editDespesa(id){const d=STATE.despesas.find(d=>d.id===id);if(d)openLancamentoModal(d,'despesa');}

let isSaving = false; // CORREÇÃO 1: Trava de segurança global para o formulário

async function saveLancamento(e) {
  e.preventDefault();
  
  // CORREÇÃO 1: Se já estiver salvando, ignora novos cliques
  if (isSaving) return; 
  if (!validateForm('formLancamento')) return;
  
  isSaving = true;

  const tipo = document.getElementById('formLancamento').dataset.tipo || 'receita';
  const id = document.getElementById('lancId').value;
  const isRecorrente = document.getElementById('lancRecorrente').checked;
  const statusEl = document.querySelector('input[name="lancStatus"]:checked');

  const descricao = document.getElementById('lancDescricao').value.trim();
  const valor     = parseFloat(document.getElementById('lancValor').value);
  const dataField = document.getElementById('lancData').value;
  const categoria = document.getElementById('lancCategoria').value;
  const colName   = tipo === 'receita' ? 'receitas' : 'despesas';

  try {
    // Editando um lançamento já existente (instância normal, não recriamos a recorrência)
    if (id) {
      const data = { id, descricao, valor, data: dataField, categoria };
      if (tipo === 'despesa') data.status = statusEl ? statusEl.value : STATUS_PENDENTE;
      await fbAdd(colName, data);
      toast('Lançamento atualizado!');
      closeModal('modalLancamento');
      return;
    }

    // Novo lançamento recorrente: salva apenas o modelo, aparece automaticamente todo mês
    if (isRecorrente) {
      const diaMes = parseInt(document.getElementById('lancDiaMes').value, 10);
      if (!diaMes || diaMes < 1 || diaMes > 31) {
        toast('Informe um dia do mês válido (1 a 31).', 'error');
        return;
      }
      const lembrete = document.getElementById('lancLembrete').checked;
      const recorrenteData = {
        id: genId(),
        tipo, descricao, valor, categoria, diaMes, lembrete,
        criadoEm: today()
      };
      await fbAdd('recorrentes', recorrenteData);
      toast(tipo === 'receita' ? 'Entrada recorrente cadastrada!' : 'Conta recorrente cadastrada!');
      closeModal('modalLancamento');
      return;
    }

    // Lançamento normal (não recorrente)
    const data = { id: genId(), descricao, valor, data: dataField, categoria };
    if (tipo === 'despesa') data.status = statusEl ? statusEl.value : STATUS_PENDENTE;
    await fbAdd(colName, data);
    toast(tipo === 'receita' ? 'Receita adicionada!' : 'Despesa adicionada!');
    closeModal('modalLancamento');

  } catch (err) {
    toast('Erro ao salvar: ' + err.message, 'error');
  } finally {
    // CORREÇÃO 1: Libera o botão no final, quer tenha dado erro ou sucesso
    isSaving = false;
  }
}

async function marcarPago(id) {
  try {
    showSync();
    await col('despesas').doc(id).update({ status: STATUS_PAGO });
    toast('Conta marcada como paga!');
  } catch(err){toast('Erro: '+err.message,'error');}
}

/* ══════════════════════════════════════
   METAS
   ══════════════════════════════════════ */
function renderMetas() {
  const rec =filterByMonth(STATE.receitas).reduce((a,r)=>a+r.valor,0);
  const desp=filterByMonth(STATE.despesas).reduce((a,d)=>a+d.valor,0);
  const eco=rec-desp, meta=STATE.metaEconomia;
  const pct=meta>0?Math.min((eco/meta)*100,100):0;

  document.getElementById('metaEconomiaDef').textContent=fmt(meta);
  document.getElementById('metaEconomizado').textContent=fmt(eco);
  document.getElementById('metaPercent').textContent=pct.toFixed(1)+'%';
  const bar=document.getElementById('progressEconomia');
  bar.style.width=pct+'%';
  bar.className='progress-bar'+(pct>=100?' over':pct>=70?'':" warn");

  const grid=document.getElementById('metasGrid');
  if(!STATE.metas.length){grid.innerHTML=`<div class="empty-state card"><iconify-icon icon="mdi:target" width="48"></iconify-icon><p>Nenhuma meta cadastrada ainda.</p></div>`;return;}
  grid.innerHTML=STATE.metas.map(m=>{
    const p=m.alvo>0?Math.min((m.atual/m.alvo)*100,100):0;
    return `<div class="meta-card"><div class="meta-card-actions"><button class="action-btn edit" onclick="editMeta('${m.id}')"><iconify-icon icon="mdi:pencil-outline" width="16"></iconify-icon></button><button class="action-btn del" onclick="confirmDelete('meta','${m.id}')"><iconify-icon icon="mdi:trash-can-outline" width="16"></iconify-icon></button></div><div class="meta-card-header"><div><div class="meta-card-title">${m.nome}</div>${m.prazo?`<div class="meta-card-prazo">Prazo: ${fmtDate(m.prazo)}</div>`:''}</div></div><div class="meta-card-percent">${p.toFixed(1)}%</div><div class="progress-bar-container"><div class="progress-bar ${p>=100?'over':p>=70?'':'warn'}" style="width:${p}%"></div></div><div class="meta-card-values"><span class="meta-card-current">${fmt(m.atual)}</span><span class="meta-card-target">de ${fmt(m.alvo)}</span></div></div>`;
  }).join('');
}

function openMetaModal(meta=null){
  document.getElementById('formMeta').reset();
  document.getElementById('metaId').value='';
  document.getElementById('modalMetaTitulo').textContent=meta?'Editar Meta':'Nova Meta';
  if(meta){document.getElementById('metaNome').value=meta.nome;document.getElementById('metaAlvo').value=meta.alvo;document.getElementById('metaAtual').value=meta.atual;document.getElementById('metaPrazo').value=meta.prazo||'';document.getElementById('metaId').value=meta.id;}
  openModal('modalMeta');
}

function editMeta(id){const m=STATE.metas.find(m=>m.id===id);if(m)openMetaModal(m);}

async function saveMeta(e){
  e.preventDefault();
  if(!validateForm('formMeta'))return;
  const id=document.getElementById('metaId').value;
  const data={id:id||genId(),nome:document.getElementById('metaNome').value.trim(),alvo:parseFloat(document.getElementById('metaAlvo').value)||0,atual:parseFloat(document.getElementById('metaAtual').value)||0,prazo:document.getElementById('metaPrazo').value};
  try{await fbAdd('metas',data);toast(id?'Meta atualizada!':'Meta criada!');closeModal('modalMeta');}catch(err){toast('Erro: '+err.message,'error');}
}

async function saveMetaEco(e){
  e.preventDefault();
  STATE.metaEconomia=parseFloat(document.getElementById('metaEcoValor').value)||0;
  try{await fbSaveConfig();toast('Meta de economia atualizada!');closeModal('modalMetaEco');}catch(err){toast('Erro: '+err.message,'error');}
}

/* ══════════════════════════════════════
   CONTAS A PAGAR
   ══════════════════════════════════════ */
function updateContasBadge(){
  const hoje=new Date();hoje.setHours(0,0,0,0);
  const vencidas=STATE.despesas.filter(d=>{if(d.status!==STATUS_PENDENTE)return false;const dt=new Date(d.data+'T12:00:00');dt.setHours(0,0,0,0);return dt<hoje;});
  const badge=document.getElementById('contasBadge');
  badge.textContent=vencidas.length;
  badge.setAttribute('data-count',vencidas.length);
}

function renderContas(){
  // Inclui recorrentes de despesa como pendentes
  const recorrentesDesp = STATE.recorrentes
    .filter(r => r.tipo === 'despesa')
    .map(r => recorrenteParaItem(r, STATE.currentMonth, STATE.currentYear));
  const pendentes=[...STATE.despesas.filter(d=>d.status===STATUS_PENDENTE), ...recorrentesDesp];
  const pagas=filterByMonth(STATE.despesas).filter(d=>d.status===STATUS_PAGO);
  const hoje=new Date();hoje.setHours(0,0,0,0);
  const em7=new Date(hoje);em7.setDate(hoje.getDate()+7);
  const vencidas=pendentes.filter(d=>{const dt=new Date(d.data+'T12:00:00');dt.setHours(0,0,0,0);return dt<hoje;});
  const proximas=pendentes.filter(d=>{const dt=new Date(d.data+'T12:00:00');dt.setHours(0,0,0,0);return dt>=hoje&&dt<=em7;});

  const renderList=(id,list,empty,showBtn=true)=>{
    const el=document.getElementById(id);
    if(!list.length){el.innerHTML=`<p class="empty-msg">${empty}</p>`;return;}
    el.innerHTML=list.map(d=>`<div class="conta-item"><div><div class="conta-desc">${d.descricao}</div><div class="conta-meta">${d.categoria} · ${fmtDate(d.data)}</div></div><div style="display:flex;align-items:center;gap:8px"><span class="conta-valor" style="color:var(--danger)">${fmt(d.valor)}</span>${showBtn?`<button class="action-btn pay" onclick="marcarPago('${d.id}')"><iconify-icon icon="mdi:check-circle-outline" width="18"></iconify-icon></button>`:''}</div></div>`).join('');
  };
  renderList('contasVencidas',vencidas,'Nenhuma conta vencida 🎉');
  renderList('contasProximas',proximas,'Nenhuma conta próxima do vencimento');
  renderList('contasPagas',pagas,'Nenhuma conta paga este mês',false);
  updateContasBadge();
}

/* ══════════════════════════════════════
   RELATÓRIOS
   ══════════════════════════════════════ */
function renderRelatorios(){renderChartRelatorios();}

/* ══════════════════════════════════════
   CONFIGURAÇÕES
   ══════════════════════════════════════ */
function renderConfiguracoes(){
  const el=document.getElementById('categoriasList');
  el.innerHTML=STATE.categorias.map(cat=>`<span class="cat-tag">${cat}<button title="Remover" onclick="removeCategoria('${cat}')"><iconify-icon icon="mdi:close" width="13"></iconify-icon></button></span>`).join('');
  renderRecorrentes();
}

function renderRecorrentes(){
  const tbody = document.getElementById('bodyRecorrentes');
  if (!tbody) return;
  if (!STATE.recorrentes.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6"><div class="empty-state"><iconify-icon icon="mdi:autorenew" width="40"></iconify-icon><p>Nenhum lançamento recorrente cadastrado</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = STATE.recorrentes.map(r => `
    <tr>
      <td data-label="Descrição">${r.descricao}</td>
      <td data-label="Tipo"><span class="chip chip-${r.tipo==='receita'?'income':'expense'}">${r.tipo==='receita'?'Entrada':'Saída'}</span></td>
      <td data-label="Valor" style="font-weight:700">${fmt(r.valor)}</td>
      <td data-label="Dia do mês">Dia ${r.diaMes}</td>
      <td data-label="Lembrete">${r.lembrete ? '<iconify-icon icon="mdi:bell-ring-outline" width="18" style="color:var(--accent)"></iconify-icon>' : '<iconify-icon icon="mdi:bell-off-outline" width="18" style="color:var(--text-secondary)"></iconify-icon>'}</td>
      <td><button class="action-btn del" onclick="deleteRecorrente('${r.id}')" title="Cancelar recorrência"><iconify-icon icon="mdi:trash-can-outline" width="17"></iconify-icon></button></td>
    </tr>
  `).join('');
}

async function deleteRecorrente(id) {
  if (!confirm('Cancelar essa recorrência? Os lançamentos já criados não serão apagados, só vai parar de gerar novos.')) return;
  try {
    await fbDelete('recorrentes', id);
    // Não precisa deletar lançamentos filhos — recorrentes não criam mais cópias
    toast('Recorrência cancelada.');
  } catch(err) { toast('Erro: ' + err.message, 'error'); }
}

/* ══════════════════════════════════════
   RECORRÊNCIA — geração automática mensal
   ══════════════════════════════════════ */

// Retorna o dia válido para o mês (ex: dia 31 em fevereiro vira o último dia de fevereiro)
function diaValidoNoMes(ano, mesIndex, dia) {
  const ultimoDia = new Date(ano, mesIndex + 1, 0).getDate();
  return Math.min(dia, ultimoDia);
}

// Cria a ocorrência (lançamento real) de uma recorrência para um mês específico
async function criarOcorrenciaRecorrente(rec, ano, mesIndex) {
  const dia = diaValidoNoMes(ano, mesIndex, rec.diaMes);
  const dataStr = `${ano}-${String(mesIndex + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  const colName = rec.tipo === 'receita' ? 'receitas' : 'despesas';
  const data = {
    id: genId(),
    descricao: rec.descricao,
    valor: rec.valor,
    data: dataStr,
    categoria: rec.categoria,
    origemRecorrenteId: rec.id
  };
  if (rec.tipo === 'despesa') data.status = STATUS_PENDENTE;
  await fbAdd(colName, data);
}

// Gera APENAS o mês atual — verifica no Firestore se já existe antes de criar
async function gerarMesAtualRecorrente(rec) {
  const agora = new Date();
  const anoAtual = agora.getFullYear();
  const mesAtual = agora.getMonth();
  const monthKey = `${anoAtual}-${String(mesAtual + 1).padStart(2, '0')}`;

  // Só gera se a data de início do recorrente já chegou
  const inicio = new Date(rec.criadoEm + 'T12:00:00');
  if (anoAtual < inicio.getFullYear()) return;
  if (anoAtual === inicio.getFullYear() && mesAtual < inicio.getMonth()) return;

  const colName = rec.tipo === 'receita' ? 'receitas' : 'despesas';
  const dia = diaValidoNoMes(anoAtual, mesAtual, rec.diaMes);
  const dataStr = `${anoAtual}-${String(mesAtual + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

  try {
    // PASSO 1: Verifica no Firestore se já existe lançamento desse recorrente nesse mês
    // Isso resolve o problema de recorrentes antigos sem mesesGerados E evita duplicatas
    const existing = await col(colName)
      .where('origemRecorrenteId', '==', rec.id)
      .where('data', '==', dataStr)
      .get();

    if (!existing.empty) return; // já existe, não cria

    // PASSO 2: Usa transaction para marcar o mês atomicamente
    const recRef = col('recorrentes').doc(rec.id);
    let devecriar = false;

    await db.runTransaction(async (transaction) => {
      const recSnap = await transaction.get(recRef);
      if (!recSnap.exists) return;
      const mesesGerados = recSnap.data().mesesGerados || [];
      if (mesesGerados.includes(monthKey)) return;
      transaction.update(recRef, { mesesGerados: [...mesesGerados, monthKey] });
      devecriar = true;
    });

    // PASSO 3: Só cria se a transaction marcou com sucesso
    if (devecriar) {
      await criarOcorrenciaRecorrente(rec, anoAtual, mesAtual);
    }

  } catch(err) {
    console.warn('Erro ao gerar recorrente:', err);
  }
}

// Roda em todas as recorrências — apenas gera o mês atual se ainda não gerou
async function processarTodasRecorrencias() {
  if (STATE._processandoRecorrencias) return;
  STATE._processandoRecorrencias = true;
  try {
    for (const rec of STATE.recorrentes) {
      await gerarMesAtualRecorrente(rec);
    }
  } catch (err) {
    console.error('Erro ao processar recorrências:', err);
  } finally {
    STATE._processandoRecorrencias = false;
  }
}

// Verifica se hoje é o dia de algum lançamento recorrente e dispara notificação real
function verificarLembretesRecorrentes() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const hoje = new Date();
  const diaHoje = hoje.getDate();
  const mesAtualKey = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;

  STATE.recorrentes.forEach(rec => {
    if (!rec.lembrete) return;
    const diaAlvo = diaValidoNoMes(hoje.getFullYear(), hoje.getMonth(), rec.diaMes);
    if (diaHoje !== diaAlvo) return;
    if (rec.ultimoLembreteEnviado === mesAtualKey) return; // já notificou esse mês

    try {
      new Notification('TrackMoney 💰', {
        body: rec.tipo === 'despesa'
          ? `Hoje é o vencimento de "${rec.descricao}" — ${fmt(rec.valor)}`
          : `Hoje é o dia esperado de "${rec.descricao}" — ${fmt(rec.valor)}`,
        icon: 'icon-192.png'
      });
    } catch(err) { console.warn('Falha ao notificar:', err); }

    fbUpdate('recorrentes', { id: rec.id, ultimoLembreteEnviado: mesAtualKey }).catch(()=>{});
  });
}

async function addCategoria(){
  const input=document.getElementById('novaCategoria');
  const val=input.value.trim();
  if(!val){toast('Digite um nome','warning');return;}
  if(STATE.categorias.map(c=>c.toLowerCase()).includes(val.toLowerCase())){toast('Categoria já existe','warning');return;}
  STATE.categorias.push(val);
  input.value='';
  try{await fbSaveConfig();populateCategorySelects();renderConfiguracoes();toast('Categoria adicionada!');}catch(err){toast('Erro: '+err.message,'error');}
}

async function removeCategoria(cat){
  if(CATEGORIAS_PADRAO.includes(cat)){toast('Categorias padrão não podem ser removidas','warning');return;}
  STATE.categorias=STATE.categorias.filter(c=>c!==cat);
  try{await fbSaveConfig();populateCategorySelects();renderConfiguracoes();toast('Categoria removida');}catch(err){toast('Erro: '+err.message,'error');}
}

/* ══════════════════════════════════════
   DELETE
   ══════════════════════════════════════ */
let pendingDelete=null;

function confirmDelete(type,id){pendingDelete={type,id};openModal('modalConfirm');}

async function executeDelete(){
  if(!pendingDelete)return;
  const {type,id}=pendingDelete;
  try{
    if(type==='receita')  await fbDelete('receitas',id);
    if(type==='despesa')  await fbDelete('despesas',id);
    if(type==='meta')     await fbDelete('metas',id);
    toast('Registro excluído','info');
    closeModal('modalConfirm');
    pendingDelete=null;
  }catch(err){toast('Erro ao excluir: '+err.message,'error');}
}

/* ══════════════════════════════════════
   SORT
   ══════════════════════════════════════ */
function sortItems(items,field,asc){
  return [...items].sort((a,b)=>{
    let va=a[field],vb=b[field];
    if(field==='valor'){va=+va;vb=+vb;}
    if(field==='data'){va=new Date(va);vb=new Date(vb);}
    if(va<vb)return asc?-1:1;
    if(va>vb)return asc?1:-1;
    return 0;
  });
}

/* ══════════════════════════════════════
   FORM VALIDATION
   ══════════════════════════════════════ */
function validateForm(formId){
  const form=document.getElementById(formId);
  let valid=true;

  form.querySelectorAll('.input.error').forEach(el=>el.classList.remove('error'));
  form.querySelectorAll('.field-error').forEach(el=>el.remove());

  function addError(el, msg){
    el.classList.add('error');
    if(!el.parentNode.querySelector('.field-error')){
      const err=document.createElement('span');
      err.className='field-error';
      err.textContent=msg;
      el.parentNode.appendChild(err);
    }
    valid=false;
  }

  // Campos obrigatórios em geral (select, texto, data)
  form.querySelectorAll('[required]').forEach(el=>{
    if(el.type==='number') return; // número tratado separadamente abaixo
    if(!el.value || !el.value.trim()){
      addError(el, 'Campo obrigatório');
    }
  });

  // Campos de descrição: mínimo de 2 caracteres com conteúdo real
  form.querySelectorAll('input[id$="Descricao"], input#metaNome').forEach(el=>{
    const val = el.value.trim();
    if(val && val.length < 2){
      addError(el, 'Descrição muito curta (mínimo 2 caracteres)');
    }
  });

  // Campos numéricos (valor): precisa ser número válido e maior que o mínimo definido
  form.querySelectorAll('input[type="number"]').forEach(el=>{
    if(!el.value && !el.required) return; // opcional e vazio, ok
    const num = parseFloat(el.value);
    const min = el.hasAttribute('min') ? parseFloat(el.min) : null;

    if(el.required && el.value.trim()===''){
      addError(el, 'Campo obrigatório');
    } else if(el.value !== '' && isNaN(num)){
      addError(el, 'Informe um número válido');
    } else if(min !== null && !isNaN(num) && num < min){
      addError(el, min > 0 ? 'Valor deve ser maior que zero' : `Valor mínimo é ${min}`);
    } else if(!isNaN(num) && num > 999999999){
      addError(el, 'Valor muito alto');
    }
  });

  // Campos de data: verifica se é uma data real e dentro de um intervalo razoável
  form.querySelectorAll('input[type="date"]').forEach(el=>{
    if(!el.value) return; // se obrigatório, já caiu no check de required acima
    const d = new Date(el.value + 'T12:00:00');
    const anoMin = 2000, anoMax = new Date().getFullYear() + 10;
    if(isNaN(d.getTime())){
      addError(el, 'Data inválida');
    } else if(d.getFullYear() < anoMin || d.getFullYear() > anoMax){
      addError(el, `Informe uma data entre ${anoMin} e ${anoMax}`);
    }
  });

  return valid;
}

/* ══════════════════════════════════════
   EXPORT
   ══════════════════════════════════════ */
function exportCSV(){
  const rows=[['Tipo','Descrição','Valor','Data','Categoria','Status']];
  filterByMonth(STATE.receitas).forEach(r=>rows.push(['Receita',r.descricao,r.valor,fmtDate(r.data),r.categoria,'']));
  filterByMonth(STATE.despesas).forEach(d=>rows.push(['Despesa',d.descricao,d.valor,fmtDate(d.data),d.categoria,d.status]));
  const csv=rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadBlob(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'}),`trackmoney_${STATE.currentYear}_${String(STATE.currentMonth+1).padStart(2,'0')}.csv`);
  toast('CSV exportado!');
}

function exportPDF(){
  try{
    const {jsPDF}=window.jspdf;
    const doc=new jsPDF();
    const month=capitalize(monthLabel(STATE.currentMonth,STATE.currentYear));
    let y=20;
    doc.setFontSize(18);doc.setFont(undefined,'bold');doc.text('TrackMoney — Relatório Mensal',14,y);y+=8;
    doc.setFontSize(11);doc.setFont(undefined,'normal');doc.setTextColor(100);doc.text(month,14,y);y+=12;
    const rec=filterByMonth(STATE.receitas),desp=filterByMonth(STATE.despesas);
    const totalR=rec.reduce((a,r)=>a+r.valor,0),totalD=desp.reduce((a,d)=>a+d.valor,0);
    doc.setTextColor(0);doc.setFontSize(12);doc.setFont(undefined,'bold');doc.text('Resumo',14,y);y+=7;
    doc.setFontSize(10);doc.setFont(undefined,'normal');
    doc.text(`Receitas:  ${fmt(totalR)}`,14,y);y+=6;
    doc.text(`Despesas:  ${fmt(totalD)}`,14,y);y+=6;
    doc.text(`Saldo:     ${fmt(totalR-totalD)}`,14,y);y+=12;
    const addTable=(title,items,cols,color)=>{
      if(!items.length)return;
      doc.setFontSize(12);doc.setFont(undefined,'bold');doc.setTextColor(...color);doc.text(title,14,y);y+=7;
      doc.setTextColor(0);doc.setFont(undefined,'normal');doc.setFontSize(9);
      items.forEach(it=>{if(y>270){doc.addPage();y=20;}doc.text(cols.map(c=>String(it[c]||'')).join('   |   '),14,y);y+=6;});
      y+=4;
    };
    addTable('Receitas',rec,['descricao','valor','data','categoria'],[16,120,60]);
    addTable('Despesas',desp,['descricao','valor','data','categoria','status'],[200,50,50]);
    doc.save(`trackmoney_${STATE.currentYear}_${String(STATE.currentMonth+1).padStart(2,'0')}.pdf`);
    toast('PDF exportado!');
  }catch(e){toast('Erro ao exportar PDF: '+e.message,'error');}
}

function downloadBlob(blob,filename){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();URL.revokeObjectURL(a.href);}

async function clearAllData(){
  if(!confirm('Tem certeza? Todos os dados serão apagados do Firestore!'))return;
  try{
    showSync();
    const batch=db.batch();
    const [rs,ds,ms]=[
      await col('receitas').get(),
      await col('despesas').get(),
      await col('metas').get()
    ];
    [...rs.docs,...ds.docs,...ms.docs].forEach(d=>batch.delete(d.ref));
    await batch.commit();
    STATE.metaEconomia=0;
    STATE.categorias=[...CATEGORIAS_PADRAO];
    await fbSaveConfig();
    toast('Dados apagados','warning');
  }catch(err){toast('Erro: '+err.message,'error');}
}

/* ══════════════════════════════════════
   EVENT LISTENERS
   ══════════════════════════════════════ */
function initEvents(){
  document.querySelectorAll('.nav-item').forEach(item=>{item.addEventListener('click',()=>navigate(item.dataset.page));});
  document.querySelectorAll('[data-nav]').forEach(btn=>{btn.addEventListener('click',()=>navigate(btn.dataset.page));});
  document.getElementById('menuToggle').addEventListener('click',openSidebar);
  document.getElementById('sidebarClose').addEventListener('click',closeSidebar);
  document.getElementById('overlay').addEventListener('click',closeSidebar);
  // Fecha o dropdown de perfil ao clicar fora dele (registrado uma única vez)
  document.addEventListener('click', (e) => {
    const chip2 = document.getElementById('userChip');
    if (chip2 && !chip2.contains(e.target)) chip2.classList.remove('open');
  });
  document.getElementById('themeToggle').addEventListener('click',async()=>{const t=STATE.theme==='light'?'dark':'light';applyTheme(t);await fbSaveConfig();});
  document.getElementById('prevMonth').addEventListener('click',()=>{STATE.currentMonth--;if(STATE.currentMonth<0){STATE.currentMonth=11;STATE.currentYear--;}updateMonthLabel();refreshCurrentPage();});
  document.getElementById('nextMonth').addEventListener('click',()=>{STATE.currentMonth++;if(STATE.currentMonth>11){STATE.currentMonth=0;STATE.currentYear++;}updateMonthLabel();refreshCurrentPage();});
  document.querySelectorAll('[data-close]').forEach(btn=>{btn.addEventListener('click',()=>closeModal(btn.dataset.close));});
  document.querySelectorAll('.modal-overlay').forEach(o=>{o.addEventListener('click',e=>{if(e.target===o)closeModal(o.id);});});
  document.getElementById('btnNovoLancamento').addEventListener('click',()=>{populateCategorySelects();openLancamentoModal();});
  document.getElementById('btnNovaMeta').addEventListener('click',()=>openMetaModal());
  document.getElementById('btnEditarMetaEco').addEventListener('click',()=>{document.getElementById('metaEcoValor').value=STATE.metaEconomia||'';openModal('modalMetaEco');});
  document.getElementById('formLancamento').addEventListener('submit',saveLancamento);
  document.getElementById('btnTipoEntrada').addEventListener('click',()=>setTipoLancamento('receita'));
  document.getElementById('btnTipoSaida').addEventListener('click',()=>setTipoLancamento('despesa'));
  document.getElementById('lancRecorrente').addEventListener('change',toggleRecorrenteFields);
  document.getElementById('formMeta').addEventListener('submit',saveMeta);
  document.getElementById('formMetaEco').addEventListener('submit',saveMetaEco);
  document.getElementById('btnConfirmDelete').addEventListener('click',executeDelete);
  document.getElementById('filtroLancamentos').addEventListener('input',renderLancamentos);
  document.getElementById('filtroTipoLancamento').addEventListener('change',renderLancamentos);
  document.getElementById('filtroCategoriaLancamento').addEventListener('change',renderLancamentos);
  document.getElementById('filtroStatusLancamento').addEventListener('change',renderLancamentos);
  document.querySelectorAll('th[data-sort]').forEach(th=>{th.addEventListener('click',()=>{const field=th.dataset.sort;if(STATE.sort.field===field)STATE.sort.asc=!STATE.sort.asc;else{STATE.sort.field=field;STATE.sort.asc=true;}if(th.closest('#tabelaLancamentos'))renderLancamentos();});});
  document.getElementById('btnExportCSV').addEventListener('click',exportCSV);
  document.getElementById('btnExportPDF').addEventListener('click',exportPDF);
  document.getElementById('btnLimparDados').addEventListener('click',clearAllData);
  document.getElementById('btnAddCategoria').addEventListener('click',addCategoria);
  document.getElementById('novaCategoria').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addCategoria();}});
  document.querySelectorAll('.input').forEach(el=>{el.addEventListener('input',()=>{el.classList.remove('error');const err=el.parentNode.querySelector('.field-error');if(err)err.remove();});});
}

/* ══════════════════════════════════════
   INIT
   ══════════════════════════════════════ */
/* ══════════════════════════════════════
   PWA — INSTALAR + NOTIFICAÇÕES
   ══════════════════════════════════════ */

let deferredInstallPrompt = null;

// Captura o evento de instalação do browser
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;

  // Mostra o botão instalar
  const btn = document.getElementById('btnInstall');
  if (btn) btn.style.display = 'flex';
});

// Quando o app for instalado, esconde o botão
window.addEventListener('appinstalled', () => {
  const btn = document.getElementById('btnInstall');
  if (btn) btn.style.display = 'none';
  deferredInstallPrompt = null;
  toast('App instalado com sucesso! 🎉');
});

async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') return;
  if (Notification.permission === 'denied') return;

  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      toast('Notificações ativadas! 🔔');
      // Salva preferência no Firestore se logado
      if (uid) {
        await userDoc().set({ notificacoesAtivas: true }, { merge: true });
      }
    }
  } catch(err) {
    console.log('Notificação negada:', err);
  }
}

async function installPWA() {
  if (!deferredInstallPrompt) {
    // App já instalado — só pede notificação
    await requestNotificationPermission();
    return;
  }

  // Mostra prompt de instalação nativo
  deferredInstallPrompt.prompt();

  const { outcome } = await deferredInstallPrompt.userChoice;

  deferredInstallPrompt = null;
  const btn = document.getElementById('btnInstall');
  if (btn) btn.style.display = 'none';

  // Pede notificação independente do resultado (accepted ou dismissed)
  // pois no Android o appinstalled pode não disparar
  setTimeout(async () => {
    await requestNotificationPermission();
  }, 800);
}

window.editReceita     = editReceita;
window.editDespesa     = editDespesa;
window.editMeta        = editMeta;
window.marcarPago      = marcarPago;
window.confirmDelete   = confirmDelete;
window.deleteRecorrente = deleteRecorrente;
window.removeCategoria = removeCategoria;

document.addEventListener('DOMContentLoaded', () => {
  initEvents();
  initAuth();

  // Botão instalar
  document.getElementById('btnInstall')?.addEventListener('click', installPWA);
});