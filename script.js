import { auth, db } from "./firebase.js";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

/* ===================== DATA ===================== */
const LOBBIES = [
  { id:"br-solo", tag:"BATTLE ROYALE · SOLO", title:"Isolated Solo Drop", desc:"Survive the Isolated map solo. Top 3 finishers split the pool.", fee:2, rewardMin:3, rewardMax:6, players:42, max:60, color:"#8B5CF6", letter:"B" },
  { id:"ranked-rush", tag:"RANKED", title:"Ranked Rush", desc:"Win 3 ranked matches in a row to unlock the bonus pool.", fee:3, rewardMin:4, rewardMax:9, players:128, max:150, color:"#EC4899", letter:"R" },
  { id:"mp-domination", tag:"MULTIPLAYER · TDM", title:"Domination Ladder", desc:"Best K/D across 5 TDM matches takes the lobby.", fee:1.5, rewardMin:2, rewardMax:5, players:76, max:100, color:"#F97316", letter:"D" },
  { id:"snipers-only", tag:"MULTIPLAYER · SNIPERS", title:"Snipers Only", desc:"One-shot rules on Standoff. Highest kill count wins.", fee:2.5, rewardMin:3, rewardMax:7, players:30, max:40, color:"#22D3EE", letter:"S" },
  { id:"clip-bounty", tag:"COMMUNITY", title:"Squad Clip Bounty", desc:"Submit your best squad wipe clip and get voted the winner.", fee:1, rewardMin:2, rewardMax:4, players:95, max:120, color:"#A855F7", letter:"C" },
  { id:"gunfight", tag:"GUNFIGHT · 2V2", title:"Gunfight Gauntlet", desc:"Single-elimination 2v2 knockout bracket. Winner takes it all.", fee:4, rewardMin:6, rewardMax:14, players:16, max:32, color:"#34D399", letter:"G" },
];

const LEADERBOARD = [
  { name:"JayMoss", sub:"Ranked Rush · 14 wins", amount:82.40, color:"#8B5CF6" },
  { name:"NyxHunter", sub:"Gunfight Gauntlet · 9 wins", amount:66.10, color:"#EC4899" },
  { name:"ZeroKelvin", sub:"Isolated Solo Drop · 11 wins", amount:54.75, color:"#F97316" },
  { name:"Ashlynn.gg", sub:"Domination Ladder · 7 wins", amount:41.20, color:"#22D3EE" },
  { name:"KairoSix", sub:"Snipers Only · 6 wins", amount:33.90, color:"#34D399" },
];

const WITHDRAW_MIN = 30;   // balance needed before a user can withdraw

/* ===================== FIREBASE STATE ===================== */
let currentUser = null;      // { id, email, gamertag, uid (CODM UID), avatar }
let walletCache = null;      // in-memory copy of wallets/{id}
let signupInFlight = false;
let welcomeMsg = null;

const getWallet = () => walletCache;
const saveWallet = (_email, w) => {
  walletCache = w;
  if(!currentUser) return;
  setDoc(doc(db, "wallets", currentUser.id), w).catch((err) => {
    console.error(err);
    toast("Couldn't sync your wallet. Check your connection.", "error");
  });
};

function authError(err){
  switch(err && err.code){
    case "auth/email-already-in-use": return "An account with this email already exists.";
    case "auth/invalid-email": return "Enter a valid email address.";
    case "auth/weak-password": return "Password must be at least 6 characters.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found": return "Email or password is incorrect.";
    case "auth/too-many-requests": return "Too many attempts. Try again in a few minutes.";
    case "auth/network-request-failed": return "Network error. Check your connection.";
    default: return "Something went wrong. Please try again.";
  }
}

function shrinkImage(dataUrl, max = 256){
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/* ===================== TOASTS ===================== */
function toast(msg, type=""){
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => el.remove(), 2900);
}

/* ===================== AUTH SCREEN LOGIC ===================== */
const tabs = document.querySelectorAll(".tab");
const forms = document.querySelectorAll(".auth-form");

function switchTab(name){
  tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  forms.forEach(f => f.classList.toggle("active", f.id === `${name}-form`));
}
tabs.forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));
document.querySelectorAll("[data-switch]").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.switch)));

/* ===================== AUTH MODAL (guest gate) ===================== */
const authModalOverlay = document.getElementById("auth-modal-overlay");

function openAuthModal(tab = "login"){
  switchTab(tab);
  authModalOverlay.classList.add("open");
}
function closeAuthModal(){
  authModalOverlay.classList.remove("open");
}
document.getElementById("close-auth-modal").addEventListener("click", closeAuthModal);
authModalOverlay.addEventListener("click", (e) => {
  if(e.target === authModalOverlay) closeAuthModal();
});

document.getElementById("nav-login-btn").addEventListener("click", () => openAuthModal("login"));
document.getElementById("nav-signup-btn").addEventListener("click", () => openAuthModal("signup"));
document.getElementById("hero-signup-cta").addEventListener("click", () => openAuthModal("signup"));
document.getElementById("hero-login-cta").addEventListener("click", () => openAuthModal("login"));
document.getElementById("hero-primary-cta").addEventListener("click", () => {
  if(currentUser){
    document.getElementById("lobbies").scrollIntoView({ behavior:"smooth" });
  } else {
    openAuthModal("signup");
  }
});

/* Toggle every .auth-only / .guest-only element based on login state */
function setAuthUI(loggedIn){
  document.querySelectorAll(".auth-only").forEach(el => el.classList.toggle("hidden", !loggedIn));
  document.querySelectorAll(".guest-only").forEach(el => el.classList.toggle("hidden", loggedIn));
  document.body.classList.toggle("has-bottom-nav", loggedIn);
  // guests see the whole landing page; signed-in users see one screen at a time
  if(!loggedIn) document.querySelectorAll("[data-view]").forEach(el => el.classList.remove("view-hidden"));
}

// avatar upload preview
const avatarInput = document.getElementById("avatar-input");
const avatarTrigger = document.getElementById("avatar-trigger");
const avatarPreview = document.getElementById("avatar-preview");
const avatarPlus = document.getElementById("avatar-plus");
let avatarDataUrl = null;
avatarTrigger.addEventListener("click", () => avatarInput.click());
avatarInput.addEventListener("change", () => {
  const file = avatarInput.files[0];
  if(!file) return;
  if(file.size > 5*1024*1024){ toast("Image must be under 5MB", "error"); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    avatarDataUrl = e.target.result;
    avatarPreview.src = avatarDataUrl;
    avatarPreview.hidden = false;
    avatarPlus.hidden = true;
  };
  reader.readAsDataURL(file);
});

// signup
document.getElementById("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const accountName = f.accountname.value.trim();
  const gamertag = f.gamertag.value.trim();
  const uid = f.uid.value.trim();
  const email = f.email.value.trim().toLowerCase();
  const password = f.password.value;
  const errorEl = document.querySelector('[data-error-for="signup"]');
  const submitBtn = f.querySelector('button[type="submit"]');
  errorEl.textContent = "";

  if(gamertag.length < 3){ errorEl.textContent = "Gamer tag must be at least 3 characters."; return; }
  if(password.length < 6){ errorEl.textContent = "Password must be at least 6 characters."; return; }

  submitBtn.disabled = true;
  signupInFlight = true;
  try{
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const avatar = avatarDataUrl ? await shrinkImage(avatarDataUrl) : null;
    await setDoc(doc(db, "users", cred.user.uid), { accountName, gamertag, uid, email, avatar, createdAt: new Date().toISOString() });
    await setDoc(doc(db, "wallets", cred.user.uid), {
      balance: 10,
      matches: 0,
      wins: 0,
      activeLobby: null,
      history: [{ name:"Welcome bonus", amount:10, date: new Date().toISOString(), type:"pos" }]
    });

    f.reset();
    avatarPreview.hidden = true;
    avatarPlus.hidden = false;
    avatarDataUrl = null;

    await loadSession(cred.user);
    afterSignIn("Account created — welcome to Praxio!");
  } catch(err){
    console.error(err);
    errorEl.textContent = authError(err);
  } finally {
    signupInFlight = false;
    submitBtn.disabled = false;
  }
});

// login
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const email = f.email.value.trim().toLowerCase();
  const password = f.password.value;
  const errorEl = document.querySelector('[data-error-for="login"]');
  const submitBtn = f.querySelector('button[type="submit"]');
  errorEl.textContent = "";

  submitBtn.disabled = true;
  welcomeMsg = "Welcome back!";
  try{
    await signInWithEmailAndPassword(auth, email, password);
    f.reset();
  } catch(err){
    welcomeMsg = null;
    errorEl.textContent = authError(err);
  } finally {
    submitBtn.disabled = false;
  }
});

function afterSignIn(msg){
  closeAuthModal();
  window.scrollTo({ top:0, behavior:"smooth" });
  toast(msg, "success");
}

async function logOut(){
  try{ await signOut(auth); } catch(err){ console.error(err); }
  toast("Logged out");
  window.scrollTo({ top:0, behavior:"smooth" });
}
document.getElementById("logout-btn").addEventListener("click", logOut);

/* ===================== APP BOOT ===================== */
// Public landing content renders regardless of auth state.
function boot(){
  renderLobbies();
  renderLeaderboard();
  initScrollReveal();
}

async function loadSession(fbUser){
  const userRef = doc(db, "users", fbUser.uid);
  const walletRef = doc(db, "wallets", fbUser.uid);
  const [userSnap, walletSnap] = await Promise.all([getDoc(userRef), getDoc(walletRef)]);

  let profile = userSnap.exists() ? userSnap.data() : null;
  if(!profile){
    profile = { gamertag: (fbUser.email || "player").split("@")[0], uid:"", email: fbUser.email, avatar:null, createdAt: new Date().toISOString() };
    await setDoc(userRef, profile);
  }

  let wallet = walletSnap.exists() ? walletSnap.data() : null;
  if(!wallet){
    wallet = { balance:10, matches:0, wins:0, activeLobby:null, history:[] };
    await setDoc(walletRef, wallet);
  }
  wallet.history = wallet.history || [];

  currentUser = { id: fbUser.uid, email: fbUser.email, gamertag: profile.gamertag, uid: profile.uid || "", avatar: profile.avatar || null, accountName: profile.accountName || "", lastChanged: profile.lastChanged || {} };
  walletCache = wallet;

  setAuthUI(true);
  updateBottomNavProfile();
  showView("praxio");
  document.getElementById("profile-initial").textContent = currentUser.gamertag[0].toUpperCase();
  document.getElementById("dropdown-gamertag").textContent = currentUser.gamertag;
  document.getElementById("dropdown-email").textContent = currentUser.email;
  renderWallet();
}

function clearSession(){
  currentUser = null;
  walletCache = null;
  setAuthUI(false);
  updateBottomNavProfile();
  closeDrawer();
  profileDropdown.classList.remove("open");
}

/* ===================== WALLET RENDERING ===================== */
function renderWallet(){
  const wallet = getWallet(currentUser.email);
  const balanceStr = `$${wallet.balance.toFixed(2)}`;
  document.getElementById("wallet-balance-nav").textContent = balanceStr;
  document.getElementById("wallet-balance-hero").textContent = balanceStr;
  document.getElementById("drawer-balance").textContent = balanceStr;
  document.getElementById("active-lobby-name").textContent = wallet.activeLobby || "None yet";

  const weekEarnings = wallet.history
    .filter(h => h.type === "pos" && h.name !== "Deposit")
    .reduce((sum,h) => sum + h.amount, 0);
  document.getElementById("stat-week").textContent = `+$${weekEarnings.toFixed(2)}`;
  document.getElementById("stat-xp").textContent = `+${wallet.matches * 15} XP`;

  document.getElementById("drawer-matches").textContent = wallet.matches;
  const winRate = wallet.matches ? Math.round((wallet.wins / wallet.matches) * 100) : 0;
  document.getElementById("drawer-winrate").textContent = `${winRate}%`;

  document.getElementById("withdraw-btn").disabled = wallet.balance < WITHDRAW_MIN;
  document.getElementById("drawer-hint").textContent = wallet.balance < WITHDRAW_MIN
    ? `Withdrawals unlock at $${WITHDRAW_MIN}. You need $${(WITHDRAW_MIN - wallet.balance).toFixed(2)} more.`
    : "You can withdraw your balance.";

  const txList = document.getElementById("tx-list");
  txList.innerHTML = "";
  if(wallet.history.length === 0){
    txList.innerHTML = `<p class="tx-empty">No transactions yet. Join a lobby to get started.</p>`;
  } else {
    [...wallet.history].reverse().forEach(tx => {
      const row = document.createElement("div");
      row.className = "tx-row";
      const date = new Date(tx.date);
      row.innerHTML = `
        <div>
          <p class="tx-name">${tx.name}</p>
          <p class="tx-date">${date.toLocaleDateString()} · ${date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</p>
        </div>
        <span class="tx-amount ${tx.type === 'pos' ? 'pos' : 'neg'}">${tx.type === 'pos' ? '+' : '-'}$${Math.abs(tx.amount).toFixed(2)}</span>
      `;
      txList.appendChild(row);
    });
  }

  renderDashboard();
}

document.getElementById("withdraw-btn").addEventListener("click", () => {
  const wallet = getWallet();
  if(!wallet || wallet.balance < WITHDRAW_MIN){
    toast(`You need $${WITHDRAW_MIN} to withdraw.`, "error");
    return;
  }
  toast("Withdrawals aren't live in this demo yet.", "error");
});

/* ===================== DEPOSIT ===================== */
const depositOverlay = document.getElementById("deposit-modal-overlay");
const depositInput = document.getElementById("deposit-amount");
const depositError = document.getElementById("deposit-error");
const depositChips = document.querySelectorAll(".amount-chip");

function openDeposit(){
  depositInput.value = "";
  depositError.textContent = "";
  depositChips.forEach(c => c.classList.remove("active"));
  depositOverlay.classList.add("open");
  setTimeout(() => depositInput.focus(), 250);
}
function closeDeposit(){ depositOverlay.classList.remove("open"); }

depositChips.forEach(chip => {
  chip.addEventListener("click", () => {
    depositInput.value = chip.dataset.amt;
    depositError.textContent = "";
    depositChips.forEach(c => c.classList.toggle("active", c === chip));
  });
});
depositInput.addEventListener("input", () => {
  depositChips.forEach(c => c.classList.toggle("active", c.dataset.amt === depositInput.value));
});
document.getElementById("close-deposit").addEventListener("click", closeDeposit);
depositOverlay.addEventListener("click", (e) => { if(e.target === depositOverlay) closeDeposit(); });
document.getElementById("deposit-btn").addEventListener("click", openDeposit);
document.getElementById("dash-deposit").addEventListener("click", openDeposit);

document.getElementById("confirm-deposit-btn").addEventListener("click", () => {
  const amount = Math.round(parseFloat(depositInput.value) * 100) / 100;
  if(!currentUser){ return; }
  if(!amount || amount < 1){ depositError.textContent = "Minimum deposit is $1.00."; return; }
  if(amount > 500){ depositError.textContent = "Maximum deposit is $500.00."; return; }

  const wallet = getWallet();
  wallet.balance = Math.round((wallet.balance + amount) * 100) / 100;
  wallet.history.push({ name:"Deposit", amount, date: new Date().toISOString(), type:"pos" });
  saveWallet(currentUser.email, wallet);
  renderWallet();
  closeDeposit();
  toast(`$${amount.toFixed(2)} added to your wallet`, "success");
});

/* ===================== EDIT PROFILE (7-day lock per field) ===================== */
const EDIT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const EDITABLE_FIELDS = {
  accountName: {
    label: "Account name",
    validate: (v) => (v.length >= 2 && v.length <= 40) ? "" : "Account name must be 2–40 characters."
  },
  gamertag: {
    label: "Gamer tag",
    validate: (v) => /^[A-Za-z0-9._-]{3,20}$/.test(v) ? "" : "Gamer tag must be 3–20 characters: letters, numbers, dot, dash or underscore."
  },
  uid: {
    label: "CODM UID",
    validate: (v) => (v === "" || /^\d{5,20}$/.test(v)) ? "" : "CODM UID must be 5–20 digits."
  }
};

const tsToMs = (t) => !t ? 0 : (typeof t.toMillis === "function" ? t.toMillis() : (new Date(t).getTime() || 0));
function lockedFor(key){
  const last = tsToMs(currentUser.lastChanged && currentUser.lastChanged[key]);
  return Math.max(0, last + EDIT_COOLDOWN_MS - Date.now());
}
function formatWait(ms){
  const mins = Math.ceil(ms / 60000);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if(d > 0) return `${d}d ${h}h`;
  if(h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const editOverlay = document.getElementById("edit-modal-overlay");
const editForm = document.getElementById("edit-profile-form");
const editError = document.getElementById("edit-error");
const saveProfileBtn = document.getElementById("save-profile-btn");
let editConfirming = false;

function resetEditConfirm(){
  editConfirming = false;
  saveProfileBtn.textContent = "Save changes";
}

function openEditProfile(){
  if(!currentUser) return;
  editError.textContent = "";
  resetEditConfirm();
  Object.keys(EDITABLE_FIELDS).forEach(key => {
    const input = document.getElementById(`edit-${key}`);
    const note = document.getElementById(`edit-note-${key}`);
    const wait = lockedFor(key);
    input.value = currentUser[key] || "";
    input.disabled = wait > 0;
    note.textContent = wait > 0
      ? `Locked. You can change this again in ${formatWait(wait)}.`
      : "You can change this now. After saving, it locks for 7 days.";
    note.classList.toggle("locked", wait > 0);
  });
  editOverlay.classList.add("open");
}
function closeEditProfile(){ editOverlay.classList.remove("open"); }

editForm.addEventListener("input", () => { editError.textContent = ""; resetEditConfirm(); });
document.getElementById("close-edit").addEventListener("click", closeEditProfile);
editOverlay.addEventListener("click", (e) => { if(e.target === editOverlay) closeEditProfile(); });
document.getElementById("edit-profile-btn").addEventListener("click", openEditProfile);
document.getElementById("dropdown-edit-btn").addEventListener("click", openEditProfile);

editForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if(!currentUser) return;
  editError.textContent = "";

  const changes = {};
  for(const key of Object.keys(EDITABLE_FIELDS)){
    const input = document.getElementById(`edit-${key}`);
    if(input.disabled) continue;
    const val = input.value.trim();
    if(val === (currentUser[key] || "")) continue;
    const msg = EDITABLE_FIELDS[key].validate(val);
    if(msg){ editError.textContent = msg; resetEditConfirm(); return; }
    changes[key] = val;
  }
  const keys = Object.keys(changes);
  if(!keys.length){ editError.textContent = "Nothing to save. Change a field first."; return; }

  // second click confirms, because the change can't be undone for 7 days
  if(!editConfirming){
    editConfirming = true;
    saveProfileBtn.textContent = "Confirm and lock for 7 days";
    editError.textContent = `${keys.map(k => EDITABLE_FIELDS[k].label).join(", ")} will be locked for 7 days after you save.`;
    return;
  }

  saveProfileBtn.disabled = true;
  try{
    const payload = {};
    keys.forEach(k => {
      payload[k] = changes[k];
      payload[`lastChanged.${k}`] = serverTimestamp();
    });
    const userRef = doc(db, "users", currentUser.id);
    await updateDoc(userRef, payload);

    const snap = await getDoc(userRef);
    const p = snap.data() || {};
    currentUser.gamertag = p.gamertag || currentUser.gamertag;
    currentUser.uid = p.uid || "";
    currentUser.accountName = p.accountName || "";
    currentUser.lastChanged = p.lastChanged || {};

    document.getElementById("profile-initial").textContent = currentUser.gamertag[0].toUpperCase();
    document.getElementById("dropdown-gamertag").textContent = currentUser.gamertag;
    updateBottomNavProfile();
    renderDashboard();
    closeEditProfile();
    toast("Profile updated. Those fields are locked for 7 days.", "success");
  } catch(err){
    console.error(err);
    editError.textContent = err && err.code === "permission-denied"
      ? "You changed one of these fields recently. Try again once the 7 days are over."
      : "Couldn't save your changes. Check your connection and try again.";
  } finally {
    saveProfileBtn.disabled = false;
    resetEditConfirm();
  }
});

/* ===================== LOBBY RENDERING ===================== */
function renderLobbies(){
  const grid = document.getElementById("lobby-grid");
  grid.innerHTML = "";
  LOBBIES.forEach(lobby => {
    const pct = Math.round((lobby.players / lobby.max) * 100);
    const card = document.createElement("div");
    card.className = "lobby-card";
    card.setAttribute("data-reveal","");
    card.innerHTML = `
      <span class="lobby-icon" style="background:${lobby.color}">${lobby.letter}</span>
      <p class="lobby-tag">${lobby.tag}</p>
      <h3>${lobby.title}</h3>
      <p class="desc">${lobby.desc}</p>
      <div class="lobby-meta">
        <div><span class="m-label">Entry</span><span class="m-value">$${lobby.fee.toFixed(2)}</span></div>
        <div><span class="m-label">Reward</span><span class="m-value mint">$${lobby.rewardMin}–$${lobby.rewardMax}</span></div>
      </div>
      <div>
        <div class="players-bar"><div class="players-bar-fill" style="width:${pct}%"></div></div>
        <p class="players-count">${lobby.players}/${lobby.max} players joined</p>
      </div>
      <button class="btn btn-primary btn-block join-btn" data-lobby="${lobby.id}">Join lobby</button>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll(".join-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if(!currentUser){
        toast("Create a free account to join a lobby");
        openAuthModal("signup");
        return;
      }
      openJoinModal(btn.dataset.lobby);
    });
  });

  initScrollReveal();
}

function renderLeaderboard(){
  const list = document.getElementById("leaderboard-list");
  list.innerHTML = "";
  LEADERBOARD.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "lb-row";
    row.setAttribute("data-reveal","");
    row.innerHTML = `
      <span class="lb-rank">#${i+1}</span>
      <span class="lb-avatar" style="background:${p.color}">${p.name[0]}</span>
      <div class="lb-info">
        <p class="lb-name">${p.name}</p>
        <p class="lb-sub">${p.sub}</p>
      </div>
      <span class="lb-amount">$${p.amount.toFixed(2)}</span>
    `;
    list.appendChild(row);
  });
  initScrollReveal();
}

/* ===================== JOIN LOBBY MODAL ===================== */
let activeLobbyData = null;
const joinOverlay = document.getElementById("join-modal-overlay");

function openJoinModal(lobbyId){
  activeLobbyData = LOBBIES.find(l => l.id === lobbyId);
  document.getElementById("join-modal-tag").textContent = activeLobbyData.tag;
  document.getElementById("join-modal-title").textContent = activeLobbyData.title;
  document.getElementById("join-modal-desc").textContent = activeLobbyData.desc;
  document.getElementById("join-modal-fee").textContent = `$${activeLobbyData.fee.toFixed(2)}`;
  document.getElementById("join-modal-reward").textContent = `$${activeLobbyData.rewardMin}–$${activeLobbyData.rewardMax}`;
  document.getElementById("join-modal-players").textContent = `${activeLobbyData.players}/${activeLobbyData.max}`;
  document.getElementById("join-modal-error").textContent = "";
  joinOverlay.classList.add("open");
}

function closeModal(overlayEl){ overlayEl.classList.remove("open"); }

document.querySelectorAll("[data-close-modal]").forEach(btn => {
  btn.addEventListener("click", () => {
    closeModal(document.getElementById("join-modal-overlay"));
    closeModal(document.getElementById("match-modal-overlay"));
  });
});

document.getElementById("confirm-join-btn").addEventListener("click", () => {
  const wallet = getWallet(currentUser.email);
  const errorEl = document.getElementById("join-modal-error");

  if(wallet.balance < activeLobbyData.fee){
    errorEl.textContent = "Insufficient balance. Top up your wallet to join this lobby.";
    return;
  }

  wallet.balance -= activeLobbyData.fee;
  wallet.activeLobby = activeLobbyData.title;
  wallet.history.push({ name:`Entry fee · ${activeLobbyData.title}`, amount: activeLobbyData.fee, date: new Date().toISOString(), type:"neg" });
  saveWallet(currentUser.email, wallet);
  renderWallet();

  closeModal(joinOverlay);
  runMatchSimulation(activeLobbyData);
});

/* ===================== MATCH SIMULATION ===================== */
function runMatchSimulation(lobby){
  const matchOverlay = document.getElementById("match-modal-overlay");
  const loadingEl = document.getElementById("match-loading");
  const resultEl = document.getElementById("match-result");
  loadingEl.hidden = false;
  resultEl.hidden = true;
  matchOverlay.classList.add("open");

  setTimeout(() => {
    const wallet = getWallet(currentUser.email);
    wallet.matches += 1;

    const didWin = Math.random() < 0.55;
    const icon = document.getElementById("result-icon");
    const title = document.getElementById("result-title");
    const desc = document.getElementById("result-desc");
    const amountEl = document.getElementById("result-amount");

    if(didWin){
      const reward = +(lobby.rewardMin + Math.random() * (lobby.rewardMax - lobby.rewardMin)).toFixed(2);
      wallet.wins += 1;
      wallet.balance += reward;
      wallet.history.push({ name:`Reward · ${lobby.title}`, amount: reward, date: new Date().toISOString(), type:"pos" });
      icon.textContent = "🏆";
      title.textContent = "Victory!";
      desc.textContent = `You placed in the money in ${lobby.title}.`;
      amountEl.textContent = `+$${reward.toFixed(2)}`;
      amountEl.className = "result-amount pos";
    } else {
      icon.textContent = "🎮";
      title.textContent = "So close!";
      desc.textContent = `You didn't place this time in ${lobby.title}. Your entry fee stays in the prize pool.`;
      amountEl.textContent = `$0.00`;
      amountEl.className = "result-amount neg";
    }

    wallet.activeLobby = null;
    saveWallet(currentUser.email, wallet);
    renderWallet();

    loadingEl.hidden = true;
    resultEl.hidden = false;
  }, 2400);
}

/* ===================== WALLET DRAWER ===================== */
const drawer = document.getElementById("wallet-drawer");
const drawerOverlay = document.getElementById("drawer-overlay");
function openDrawer(){ drawer.classList.add("open"); drawerOverlay.classList.add("open"); }
function closeDrawer(){ drawer.classList.remove("open"); drawerOverlay.classList.remove("open"); }
["open-wallet","open-wallet-2","open-wallet-mobile"].forEach(id => {
  document.getElementById(id).addEventListener("click", openDrawer);
});
document.getElementById("close-wallet").addEventListener("click", closeDrawer);
drawerOverlay.addEventListener("click", closeDrawer);

/* ===================== USER DASHBOARD ===================== */
const RANK_TITLES = ["Rookie","Operator","Veteran","Elite","Legend"];
const money = (n) => `$${n.toFixed(2)}`;

function renderDashboard(){
  if(!currentUser) return;
  const wallet = getWallet(currentUser.email);
  if(!wallet) return;
  const history = wallet.history || [];

  const hour = new Date().getHours();
  document.getElementById("dash-greeting").textContent =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  document.getElementById("dash-name").textContent = currentUser.gamertag;
  const avatarEl = document.getElementById("dash-avatar");
  if(currentUser.avatar){
    avatarEl.innerHTML = "";
    const img = document.createElement("img");
    img.src = currentUser.avatar; img.alt = "";
    avatarEl.appendChild(img);
  } else {
    avatarEl.textContent = currentUser.gamertag[0].toUpperCase();
  }

  const earned = history
    .filter(h => h.type === "pos" && h.name !== "Welcome bonus" && h.name !== "Deposit")
    .reduce((s,h) => s + h.amount, 0);
  const spent = history.filter(h => h.type === "neg").reduce((s,h) => s + h.amount, 0);
  const net = earned - spent;
  const winRate = wallet.matches ? Math.round((wallet.wins / wallet.matches) * 100) : 0;

  document.getElementById("dash-balance").textContent = money(wallet.balance);
  const remaining = WITHDRAW_MIN - wallet.balance;
  document.getElementById("dash-withdraw-note").textContent =
    remaining > 0 ? `${money(remaining)} more to withdraw` : "Ready to withdraw";
  document.getElementById("dash-earned").textContent = money(earned);
  document.getElementById("dash-net").textContent = `Net ${net < 0 ? "-" : "+"}${money(Math.abs(net))}`;
  document.getElementById("dash-matches").textContent = wallet.matches;
  document.getElementById("dash-wins").textContent = `${wallet.wins} ${wallet.wins === 1 ? "win" : "wins"}`;
  document.getElementById("dash-winrate").textContent = `${winRate}%`;
  document.getElementById("dash-winrate-bar").style.width = `${winRate}%`;

  const days = [];
  for(let i = 6; i >= 0; i--){
    const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - i);
    days.push({ date:d, total:0 });
  }
  history.forEach(h => {
    if(h.type !== "pos" || h.name === "Welcome bonus" || h.name === "Deposit") return;
    const hd = new Date(h.date); hd.setHours(0,0,0,0);
    const slot = days.find(d => d.date.getTime() === hd.getTime());
    if(slot) slot.total += h.amount;
  });
  const weekTotal = days.reduce((s,d) => s + d.total, 0);
  const maxDay = Math.max(...days.map(d => d.total), 1);
  document.getElementById("dash-week-total").textContent = `${money(weekTotal)} this week`;
  const chart = document.getElementById("dash-chart");
  chart.innerHTML = "";
  days.forEach((d, i) => {
    const col = document.createElement("div");
    col.className = "chart-col";
    const h = d.total ? Math.max(10, Math.round((d.total / maxDay) * 110)) : 4;
    col.innerHTML = `
      <span class="chart-val">${d.total ? money(d.total) : ""}</span>
      <div class="chart-bar ${d.total ? "" : "empty"} ${i === 6 ? "today" : ""}" style="height:${h}px" title="${d.date.toLocaleDateString()}: ${money(d.total)}"></div>
      <span class="chart-day">${d.date.toLocaleDateString([], { weekday:"short" })}</span>
    `;
    chart.appendChild(col);
  });

  const xp = wallet.matches * 15;
  const level = Math.floor(xp / 100) + 1;
  document.getElementById("dash-level").textContent = level;
  document.getElementById("dash-xp").textContent = xp;
  document.getElementById("dash-xp-bar").style.width = `${xp % 100}%`;
  document.getElementById("dash-xp-next").textContent = `${100 - (xp % 100)} XP to level ${level + 1}`;
  document.getElementById("dash-rank-title").textContent = RANK_TITLES[Math.min(level - 1, RANK_TITLES.length - 1)];

  document.getElementById("dash-active").classList.toggle("live", !!wallet.activeLobby);
  document.getElementById("dash-active-name").textContent = wallet.activeLobby || "No active lobby";
  document.getElementById("dash-active-sub").textContent = wallet.activeLobby ? "Match in progress…" : "Join one to start earning.";

  const rankEl = document.getElementById("dash-rank");
  const rankSub = document.getElementById("dash-rank-sub");
  if(earned <= 0){
    rankEl.textContent = "Unranked";
    rankSub.textContent = "Win a lobby to join the top earners.";
  } else {
    const pos = LEADERBOARD.filter(p => p.amount > earned).length + 1;
    rankEl.textContent = `#${pos}`;
    if(pos === 1){
      rankSub.textContent = "You're leading the top earners.";
    } else if(pos <= LEADERBOARD.length){
      rankSub.textContent = `${money(LEADERBOARD[pos-2].amount - earned)} behind #${pos-1}.`;
    } else {
      rankSub.textContent = `${money(LEADERBOARD[LEADERBOARD.length-1].amount - earned)} to reach the top ${LEADERBOARD.length}.`;
    }
  }

  document.getElementById("dash-p-name").textContent = currentUser.accountName || "Not set";
  document.getElementById("dash-p-tag").textContent = currentUser.gamertag;
  document.getElementById("dash-p-uid").textContent = currentUser.uid || "Not added";
  document.getElementById("dash-p-email").textContent = currentUser.email;

  const quick = [...LOBBIES]
    .sort((a,b) => (a.fee > wallet.balance) - (b.fee > wallet.balance) || b.rewardMax - a.rewardMax)
    .slice(0, 3);
  const quickEl = document.getElementById("dash-quick");
  quickEl.innerHTML = "";
  quick.forEach(l => {
    const row = document.createElement("div");
    row.className = "quick-row";
    row.innerHTML = `
      <span class="lobby-icon" style="background:${l.color}">${l.letter}</span>
      <div class="quick-info">
        <p class="quick-title">${l.title}</p>
        <p class="quick-meta">Entry ${money(l.fee)} · Reward <b>$${l.rewardMin}–$${l.rewardMax}</b></p>
      </div>
      <button class="btn btn-primary btn-small" data-quick="${l.id}">Join</button>
    `;
    quickEl.appendChild(row);
  });
  quickEl.querySelectorAll("[data-quick]").forEach(b => {
    b.addEventListener("click", () => openJoinModal(b.dataset.quick));
  });

  const act = document.getElementById("dash-activity");
  act.innerHTML = "";
  if(history.length === 0){
    act.innerHTML = `<p class="tx-empty">No activity yet. Join a lobby to get started.</p>`;
  } else {
    [...history].reverse().slice(0, 5).forEach(tx => {
      const date = new Date(tx.date);
      const row = document.createElement("div");
      row.className = "tx-row";
      row.innerHTML = `
        <div>
          <p class="tx-name">${tx.name}</p>
          <p class="tx-date">${date.toLocaleDateString()} · ${date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</p>
        </div>
        <span class="tx-amount ${tx.type === 'pos' ? 'pos' : 'neg'}">${tx.type === 'pos' ? '+' : '-'}${money(Math.abs(tx.amount))}</span>
      `;
      act.appendChild(row);
    });
  }
}

document.getElementById("dash-open-wallet").addEventListener("click", openDrawer);
document.getElementById("dash-view-all").addEventListener("click", openDrawer);

/* ===================== PROFILE DROPDOWN ===================== */
const profileBtn = document.getElementById("profile-btn");
const profileDropdown = document.getElementById("profile-dropdown");
profileBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  profileDropdown.classList.toggle("open");
});
document.addEventListener("click", () => profileDropdown.classList.remove("open"));

/* ===================== MOBILE NAV ===================== */
const navToggle = document.getElementById("nav-toggle");
const navLinks = document.getElementById("nav-links");
navToggle.addEventListener("click", () => {
  navToggle.classList.toggle("open");
  navLinks.classList.toggle("open");
});
navLinks.querySelectorAll(".nav-link:not(.nav-link-btn)").forEach(link => {
  link.addEventListener("click", () => { navToggle.classList.remove("open"); navLinks.classList.remove("open"); });
});

/* ===================== BOTTOM NAVIGATION ===================== */
const bottomNav = document.getElementById("bottom-nav");
const bnItems = bottomNav.querySelectorAll(".bn-item");
const lobbySearch = document.getElementById("lobby-search");
const SOON_VIEWS = {
  home: { title:"Home", desc:"Your new home page is on the way. Check back soon." },
  chat: { title:"Chat", desc:"Chat with other players is on the way. Check back soon." }
};
let currentView = "praxio";
// Signed-in users see one screen at a time: home, praxio (lobbies + leaderboard), chat or profile (dashboard)
function showView(name){
  if(!currentUser) return;
  currentView = name;
  document.querySelectorAll("[data-view]").forEach(el => {
    el.classList.toggle("view-hidden", !el.dataset.view.split(" ").includes(name));
  });
  if(SOON_VIEWS[name]){
    document.getElementById("soon-title").textContent = SOON_VIEWS[name].title;
    document.getElementById("soon-desc").textContent = SOON_VIEWS[name].desc;
  }
  setBottomNavActive(name);
  window.scrollTo({ top:0, behavior:"instant" });
}

function setBottomNavActive(name){
  bnItems.forEach(b => b.classList.toggle("active", b.dataset.nav === name));
}

function updateBottomNavProfile(){
  const el = document.getElementById("bn-avatar");
  if(!el) return;
  if(currentUser){
    if(currentUser.avatar){
      el.innerHTML = "";
      const img = document.createElement("img");
      img.src = currentUser.avatar; img.alt = "";
      el.appendChild(img);
    } else {
      el.textContent = currentUser.gamertag[0].toUpperCase();
    }
    el.classList.add("has-user");
  } else {
    el.classList.remove("has-user");
    el.innerHTML = `<svg class="bn-guest-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c.6-4.2 3.7-6.5 8-6.5s7.4 2.3 8 6.5"/></svg>`;
  }
}

function filterLobbies(){
  const q = lobbySearch.value.trim().toLowerCase();
  let visible = 0;
  document.querySelectorAll("#lobby-grid .lobby-card").forEach(card => {
    const id = card.querySelector(".join-btn").dataset.lobby;
    const l = LOBBIES.find(x => x.id === id);
    const hay = `${l.title} ${l.tag} ${l.desc}`.toLowerCase();
    const show = !q || hay.includes(q);
    card.classList.toggle("hidden", !show);
    if(show) visible++;
  });
  document.getElementById("lobby-empty").classList.toggle("hidden", visible > 0);
}
lobbySearch.addEventListener("input", filterLobbies);

bnItems.forEach(btn => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.nav;
    switch(name){
      case "home":
        showView("home");
        break;
      case "search":
        showView("praxio");
        setTimeout(() => {
          document.getElementById("lobbies").scrollIntoView({ behavior:"smooth" });
          lobbySearch.focus({ preventScroll:true });
        }, 80);
        break;
      case "praxio":
        showView("praxio");
        break;
      case "chat":
        showView("chat");
        break;
      case "profile":
        showView("profile");
        break;
    }
    setBottomNavActive(name);
  });
});

// in-page links that switch screens (e.g. "All lobbies →" on the dashboard)
document.querySelectorAll("[data-go-view]").forEach(a => {
  a.addEventListener("click", (e) => { e.preventDefault(); showView(a.dataset.goView); });
});

/* ===================== NAVBAR SCROLL STYLE + HERO PARALLAX ===================== */
const navbar = document.getElementById("navbar");
const heroEl = document.querySelector(".hero");
let scrollTicking = false;
function updateScrollEffects(){
  scrollTicking = false;
  navbar.classList.toggle("scrolled", window.scrollY > 20);
  if(heroEl && heroEl.offsetHeight){
    const progress = Math.min(Math.max(window.scrollY / (heroEl.offsetHeight * 0.85), 0), 1);
    heroEl.style.setProperty("--scroll-progress", progress.toFixed(3));
  }
}
window.addEventListener("scroll", () => {
  if(!scrollTicking){ scrollTicking = true; requestAnimationFrame(updateScrollEffects); }
}, { passive:true });
updateScrollEffects();

/* ===================== SCROLL REVEAL ===================== */
let revealObserver;
function initScrollReveal(){
  if(!revealObserver){
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if(entry.isIntersecting){
          entry.target.classList.add("in-view");
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
  }
  document.querySelectorAll("[data-reveal]:not(.in-view)").forEach(el => revealObserver.observe(el));
}

/* ===================== INIT ===================== */
boot();

const appEl = document.getElementById("app");
const finishLoading = () => appEl.classList.remove("is-loading");
setTimeout(finishLoading, 4000);

onAuthStateChanged(auth, async (fbUser) => {
  if(signupInFlight) return;
  try{
    if(fbUser){
      await loadSession(fbUser);
      if(welcomeMsg){ afterSignIn(welcomeMsg); welcomeMsg = null; }
    } else {
      clearSession();
    }
  } catch(err){
    console.error(err);
    toast("Couldn't load your account. Check your connection.", "error");
  }
  finishLoading();
});