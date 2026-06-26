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

  STATE.listeners.push(unsubRec, unsubDesp, unsubMeta, unsubCfg);
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
    dashboard:'Dashboard', receitas:'Receitas', despesas:'Despesas',
    relatorios:'Relatórios', metas:'Metas Financeiras',
    contas:'Contas a Pagar', configuracoes:'Configurações'
  };
  document.getElementById('topbarTitle').textContent = titles[pageId] || pageId;

  if (pageId === 'dashboard')     renderDashboard();
  if (pageId === 'receitas')      renderReceitas();
  if (pageId === 'despesas')      renderDespesas();
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
  ['receitaCategoria','despesaCategoria','filtroCategoriaReceita','filtroCategoriaDespesa'].forEach(id => {
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
  const totalRec  = rec.reduce((a,r)=>a+r.valor,0);
  const totalDesp = desp.reduce((a,d)=>a+d.valor,0);
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
  renderRecentTransactions([...rec, ...desp]);
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
   RECEITAS
   ══════════════════════════════════════ */
function renderReceitas() {
  populateCategorySelects();
  const search = (document.getElementById('filtroReceitas')?.value||'').toLowerCase();
  const cat    = document.getElementById('filtroCategoriaReceita')?.value||'';
  let items = filterByMonth(STATE.receitas).filter(r=>(!search||r.descricao.toLowerCase().includes(search))&&(!cat||r.categoria===cat));
  if(STATE.sort.field) items=sortItems(items,STATE.sort.field,STATE.sort.asc);
  else items.sort((a,b)=>new Date(b.data)-new Date(a.data));

  const tbody=document.getElementById('bodyReceitas');
  if(!items.length){tbody.innerHTML=`<tr class="empty-row"><td colspan="5"><div class="empty-state"><iconify-icon icon="mdi:cash-plus" width="40"></iconify-icon><p>Nenhuma receita encontrada</p></div></td></tr>`;return;}
  tbody.innerHTML=items.map(r=>`<tr><td data-label="Descrição">${r.descricao}</td><td data-label="Valor" style="color:var(--accent);font-weight:700">${fmt(r.valor)}</td><td data-label="Data">${fmtDate(r.data)}</td><td data-label="Categoria"><span class="chip chip-income">${r.categoria}</span></td><td><button class="action-btn edit" onclick="editReceita('${r.id}')"><iconify-icon icon="mdi:pencil-outline" width="17"></iconify-icon></button><button class="action-btn del" onclick="confirmDelete('receita','${r.id}')"><iconify-icon icon="mdi:trash-can-outline" width="17"></iconify-icon></button></td></tr>`).join('');
}

function openReceitaModal(receita=null) {
  document.getElementById('formReceita').reset();
  document.getElementById('receitaId').value='';
  document.getElementById('modalReceitaTitulo').textContent=receita?'Editar Receita':'Nova Receita';
  document.getElementById('receitaData').value=receita?receita.data:today();
  if(receita){document.getElementById('receitaDescricao').value=receita.descricao;document.getElementById('receitaValor').value=receita.valor;document.getElementById('receitaCategoria').value=receita.categoria;document.getElementById('receitaId').value=receita.id;}
  openModal('modalReceita');
}

function editReceita(id){const r=STATE.receitas.find(r=>r.id===id);if(r)openReceitaModal(r);}

async function saveReceita(e) {
  e.preventDefault();
  if(!validateForm('formReceita'))return;
  const id=document.getElementById('receitaId').value;
  const data={
    id: id||genId(),
    descricao: document.getElementById('receitaDescricao').value.trim(),
    valor:     parseFloat(document.getElementById('receitaValor').value),
    data:      document.getElementById('receitaData').value,
    categoria: document.getElementById('receitaCategoria').value
  };
  try {
    await fbAdd('receitas', data);
    toast(id?'Receita atualizada!':'Receita adicionada!');
    closeModal('modalReceita');
  } catch(err) { toast('Erro ao salvar: '+err.message,'error'); }
}

/* ══════════════════════════════════════
   DESPESAS
   ══════════════════════════════════════ */
function renderDespesas() {
  populateCategorySelects();
  const search=(document.getElementById('filtroDespesas')?.value||'').toLowerCase();
  const cat=document.getElementById('filtroCategoriaDespesa')?.value||'';
  const status=document.getElementById('filtroStatusDespesa')?.value||'';
  let items=filterByMonth(STATE.despesas).filter(d=>(!search||d.descricao.toLowerCase().includes(search))&&(!cat||d.categoria===cat)&&(!status||d.status===status));
  if(STATE.sort.field) items=sortItems(items,STATE.sort.field,STATE.sort.asc);
  else items.sort((a,b)=>new Date(b.data)-new Date(a.data));

  const tbody=document.getElementById('bodyDespesas');
  if(!items.length){tbody.innerHTML=`<tr class="empty-row"><td colspan="6"><div class="empty-state"><iconify-icon icon="mdi:cash-minus" width="40"></iconify-icon><p>Nenhuma despesa encontrada</p></div></td></tr>`;return;}
  tbody.innerHTML=items.map(d=>`<tr><td data-label="Descrição">${d.descricao}</td><td data-label="Valor" style="color:var(--danger);font-weight:700">${fmt(d.valor)}</td><td data-label="Data">${fmtDate(d.data)}</td><td data-label="Categoria"><span class="chip chip-expense">${d.categoria}</span></td><td data-label="Status"><span class="chip chip-${d.status}">${d.status===STATUS_PAGO?'Pago':'Pendente'}</span></td><td>${d.status===STATUS_PENDENTE?`<button class="action-btn pay" title="Marcar pago" onclick="marcarPago('${d.id}')"><iconify-icon icon="mdi:check" width="17"></iconify-icon></button>`:''}<button class="action-btn edit" onclick="editDespesa('${d.id}')"><iconify-icon icon="mdi:pencil-outline" width="17"></iconify-icon></button><button class="action-btn del" onclick="confirmDelete('despesa','${d.id}')"><iconify-icon icon="mdi:trash-can-outline" width="17"></iconify-icon></button></td></tr>`).join('');
}

function openDespesaModal(despesa=null) {
  document.getElementById('formDespesa').reset();
  document.getElementById('despesaId').value='';
  document.getElementById('modalDespesaTitulo').textContent=despesa?'Editar Despesa':'Nova Despesa';
  document.getElementById('despesaData').value=despesa?despesa.data:today();
  if(despesa){document.getElementById('despesaDescricao').value=despesa.descricao;document.getElementById('despesaValor').value=despesa.valor;document.getElementById('despesaCategoria').value=despesa.categoria;document.getElementById('despesaId').value=despesa.id;document.querySelector(`input[name="despesaStatus"][value="${despesa.status}"]`).checked=true;}
  else {document.querySelector(`input[name="despesaStatus"][value="${STATUS_PENDENTE}"]`).checked=true;}
  openModal('modalDespesa');
}

function editDespesa(id){const d=STATE.despesas.find(d=>d.id===id);if(d)openDespesaModal(d);}

async function marcarPago(id) {
  try {
    showSync();
    await col('despesas').doc(id).update({ status: STATUS_PAGO });
    toast('Conta marcada como paga!');
  } catch(err){toast('Erro: '+err.message,'error');}
}

async function saveDespesa(e) {
  e.preventDefault();
  if(!validateForm('formDespesa'))return;
  const id=document.getElementById('despesaId').value;
  const statusEl=document.querySelector('input[name="despesaStatus"]:checked');
  const data={
    id: id||genId(),
    descricao: document.getElementById('despesaDescricao').value.trim(),
    valor:     parseFloat(document.getElementById('despesaValor').value),
    data:      document.getElementById('despesaData').value,
    categoria: document.getElementById('despesaCategoria').value,
    status:    statusEl?statusEl.value:STATUS_PENDENTE
  };
  try {
    await fbAdd('despesas', data);
    toast(id?'Despesa atualizada!':'Despesa adicionada!');
    closeModal('modalDespesa');
  } catch(err){toast('Erro ao salvar: '+err.message,'error');}
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
  const pendentes=STATE.despesas.filter(d=>d.status===STATUS_PENDENTE);
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
  document.getElementById('btnNovaReceita').addEventListener('click',()=>{populateCategorySelects();openReceitaModal();});
  document.getElementById('btnNovaDespesa').addEventListener('click',()=>{populateCategorySelects();openDespesaModal();});
  document.getElementById('btnNovaMeta').addEventListener('click',()=>openMetaModal());
  document.getElementById('btnEditarMetaEco').addEventListener('click',()=>{document.getElementById('metaEcoValor').value=STATE.metaEconomia||'';openModal('modalMetaEco');});
  document.getElementById('formReceita').addEventListener('submit',saveReceita);
  document.getElementById('formDespesa').addEventListener('submit',saveDespesa);
  document.getElementById('formMeta').addEventListener('submit',saveMeta);
  document.getElementById('formMetaEco').addEventListener('submit',saveMetaEco);
  document.getElementById('btnConfirmDelete').addEventListener('click',executeDelete);
  document.getElementById('filtroReceitas').addEventListener('input',renderReceitas);
  document.getElementById('filtroCategoriaReceita').addEventListener('change',renderReceitas);
  document.getElementById('filtroDespesas').addEventListener('input',renderDespesas);
  document.getElementById('filtroCategoriaDespesa').addEventListener('change',renderDespesas);
  document.getElementById('filtroStatusDespesa').addEventListener('change',renderDespesas);
  document.querySelectorAll('th[data-sort]').forEach(th=>{th.addEventListener('click',()=>{const field=th.dataset.sort;if(STATE.sort.field===field)STATE.sort.asc=!STATE.sort.asc;else{STATE.sort.field=field;STATE.sort.asc=true;}if(th.closest('#tabelaReceitas'))renderReceitas();else renderDespesas();});});
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
window.removeCategoria = removeCategoria;

document.addEventListener('DOMContentLoaded', () => {
  initEvents();
  initAuth();

  // Botão instalar
  document.getElementById('btnInstall')?.addEventListener('click', installPWA);
});
