/* Heidi Priebe Agent — SPA. Vanilla JS, hash router, no build step, no CDNs. */

"use strict";

const app = document.getElementById("app");
const nav = document.getElementById("nav");
const modeSwitch = document.getElementById("mode-switch");

let appConfig = null;
let providers = null;
let obOptions = null;
let mode = localStorage.getItem("mode") || "companion";
// Window/document listeners that must be torn down when a view re-renders,
// or they accumulate across navigations and stack up work on every scroll/click.
let chatScrollHandler = null;
let tonePopDocHandler = null;

// ─── API + utils ───────────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function mdLite(md) {
  const lines = esc(md).split(/\r?\n/);
  let html = "", inList = false;
  const linkify = (s) =>
    s.replace(/\[\[([^\]]+)\]\]/g, (m, x) =>
      /T\d/.test(x)
        ? `<span class="sk-link" data-session="${esc(x)}">${esc(x)}</span>`
        : `<span class="tag">${esc(x)}</span>`
    ).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  for (const line of lines) {
    if (/^#\s+/.test(line)) { if (inList) { html += "</ul>"; inList = false; } html += `<h2>${linkify(line.replace(/^#\s+/, ""))}</h2>`; }
    else if (/^##\s+/.test(line)) { if (inList) { html += "</ul>"; inList = false; } html += `<h3>${linkify(line.replace(/^##\s+/, ""))}</h3>`; }
    else if (/^-\s+/.test(line)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${linkify(line.replace(/^-\s+/, ""))}</li>`; }
    else { if (inList) { html += "</ul>"; inList = false; } if (line.trim()) html += `<p>${linkify(line)}</p>`; }
  }
  if (inList) html += "</ul>";
  return html;
}

// ─── Router + chrome ─────────────────────────────────────────────────────────

const routes = {
  "/chat": renderChat,
  "/journey": renderJourney,
  "/settings": renderSettings,
  "/onboard": renderOnboard,
  "/therapist": renderTherapist,
};

function buildChrome() {
  const setup = appConfig && appConfig.setupComplete;
  modeSwitch.innerHTML = setup
    ? `<select id="mode-select" title="Switch view">
         <option value="companion" ${mode === "companion" ? "selected" : ""}>Companion</option>
         <option value="therapist" ${mode === "therapist" ? "selected" : ""}>Therapist</option>
       </select>`
    : "";
  const sel = document.getElementById("mode-select");
  if (sel) sel.addEventListener("change", () => {
    mode = sel.value;
    localStorage.setItem("mode", mode);
    location.hash = mode === "therapist" ? "#/therapist" : "#/chat";
    buildChrome();
  });

  if (!setup) { nav.innerHTML = ""; return; }
  const cur = location.hash.replace("#", "") || "/chat";
  const links = mode === "therapist"
    ? [["/therapist", "Dashboard"], ["/settings", "Settings"]]
    : [["/chat", "Talk"], ["/journey", "Journey"], ["/settings", "Settings"]];
  nav.innerHTML = links.map(([h, t]) => `<a href="#${h}" class="${cur === h || cur.startsWith(h + "/") ? "active" : ""}">${t}</a>`).join("");
}

async function handleRoute() {
  if (!appConfig) { try { appConfig = await api("GET", "/api/config"); } catch { appConfig = {}; } }
  let path = location.hash.replace("#", "") || "/chat";
  if (path === "/memory" || path.startsWith("/memory/")) { location.hash = "#/journey"; return; }
  if (!appConfig.setupComplete && path !== "/onboard") { location.hash = "#/onboard"; return; }
  if (appConfig.setupComplete && path === "/onboard") { location.hash = "#/chat"; return; }
  buildChrome();
  if (path.startsWith("/journey")) { await renderJourney(path.split("/")[2] || ""); return; }
  if (path.startsWith("/therapist")) { await renderTherapist(path.split("/")[2] || ""); return; }
  await (routes[path] || renderChat)();
}

window.addEventListener("hashchange", handleRoute);
window.addEventListener("DOMContentLoaded", handleRoute);

// ─── Onboarding ────────────────────────────────────────────────────────────────

let ob = null;

// Each topic the person can pick maps to a tailored opening question for its
// conversational section. Custom/unmapped topics get a generic seed.
// Seeds stay concrete and low-stakes — depth is earned later in real sessions,
// not demanded at a first meeting.
const TOPIC_SECTIONS = {
  "Relationships & dating": { title: "Relationships", seed: "What does your relationship life look like these days?" },
  "Anxious or avoidant patterns in love": { title: "Patterns in love", seed: "When you get close to someone, what tends to happen — do you reach for them, pull back, or something in between?" },
  "Family & how I was raised": { title: "Family", seed: "Tell me a little about your family these days — who's around, and how do things feel with them?" },
  "Feeling flawed, not enough, or ashamed": { title: "Self-worth", seed: "When does that 'not enough' feeling tend to show up for you these days?" },
  "People-pleasing & losing myself": { title: "People-pleasing", seed: "Where in your life do you find yourself saying yes when you really mean no?" },
  "Understanding & actually feeling my emotions": { title: "Emotions", seed: "When something big happens, do you tend to feel it in the moment, or does it catch up with you later?" },
  "A hard childhood / healing old wounds": { title: "Early life", seed: "Only as much as you feel like sharing — is there a part of your earlier life that still feels present today?" },
  "Grief, a breakup, or letting go": { title: "Loss & letting go", seed: "What are you carrying or trying to let go of right now — in whatever words come easily?" },
  "Boundaries & codependency": { title: "Boundaries", seed: "Where does taking care of others start to cost you — where does the line get blurry?" },
  "Being honest with myself / feeling stuck": { title: "Honesty with yourself", seed: "Where in your life does 'stuck' show up the most right now?" },
  "Personality & self-understanding": { title: "Self-understanding", seed: "How would you describe yourself to someone who's never met you?" },
  "Anxiety": { title: "Anxiety", seed: "When anxiety shows up for you, what does it tend to circle around?" },
};

const MAX_TOPIC_SECTIONS = 2; // cap topic sections to avoid fatigue

// Conversational sections, EASY → DEEPER: start with plain day-to-day life,
// then their chosen topics, then people, and only at the end the (explicitly
// optional) why-now question. All skippable at any time.
function obSectionDefs() {
  const picked = (ob.mc.topics || []).filter((t) => t && t !== "Not sure yet");
  const custom = ob.mc.other && ob.mc.other.topics && ob.mc.other.topics.trim() ? [ob.mc.other.topics.trim()] : [];
  const topics = [...picked, ...custom].slice(0, MAX_TOPIC_SECTIONS).map((t, i) => {
    const m = TOPIC_SECTIONS[t];
    return { id: "t" + i, title: m ? m.title : t, seed: m ? m.seed : `You mentioned "${t}." What's going on there for you?`, maxTurns: 2 };
  });
  return [
    { id: "today", title: "Life right now", seed: "Let's start easy. What does day-to-day life look like for you at the moment — work, school, where you're living, that kind of thing?", maxTurns: 2 },
    ...topics,
    { id: "people", title: "The people in your life", seed: "Who are the people who matter most to you right now?", maxTurns: 2 },
    { id: "why-now", title: "Why now", seed: "Last one — and only if you feel like going there: what made now feel like the moment to start doing this kind of work?", maxTurns: 2 },
  ];
}

function obSteps() {
  return ["provider", "consent", "name", "mc1", "mc2", ...obSectionDefs().map((s) => "section:" + s.id), "finish"];
}

// Progress chips across the wizard (collapses the chat sections into one stage).
function obProgressHtml() {
  const stages = [
    ["provider|consent", "Setup"],
    ["name", "Name"],
    ["mc1|mc2", "Quick taps"],
    ["section:", "A short chat"],
    ["finish", "Ready"],
  ];
  const cur = obSteps()[ob.i] || "";
  return `<div class="steps">${stages.map(([match, label]) => {
    const on = match.split("|").some((m) => cur === m || (m.endsWith(":") && cur.startsWith(m)));
    return `<span class="step ${on ? "on" : ""}">${label}</span>`;
  }).join("")}</div>`;
}

async function renderOnboard() {
  if (!providers) { try { providers = await api("GET", "/api/providers"); } catch { providers = []; } }
  if (!obOptions) { try { obOptions = await api("GET", "/api/onboard/options"); } catch { obOptions = { mc: {}, sections: [] }; } }
  if (!ob) ob = { i: 0, provider: "claude-p", model: "openai/gpt-4o-mini", consent: false, name: "", mc: { topics: [], readiness: [], tone: "balanced", emotionalStyle: [], other: { topics: "", readiness: "", tone: "", emotionalStyle: "" } }, sec: {} };

  const steps = obSteps();
  const cur = steps[ob.i];

  if (cur === "provider") return obProvider();
  if (cur === "consent") return obConsent();
  if (cur === "name") return obName();
  if (cur === "mc1") return obMC(1);
  if (cur === "mc2") return obMC(2);
  if (cur.startsWith("section:")) return obSection(cur.slice(8));
  if (cur === "finish") return obFinish();
}

function obShell(inner, opts = {}) {
  const back = ob.i > 0 && !opts.noBack ? `<button id="ob-back">Back</button>` : `<span></span>`;
  const right = opts.right != null ? opts.right : `<button class="primary" id="ob-next">${opts.nextLabel || "Next"}</button>`;
  app.innerHTML = `<div class="ob-wrap">${obProgressHtml()}${inner}<div class="row spread" style="margin-top:24px">${back}${right}</div></div>`;
  const b = document.getElementById("ob-back");
  if (b) b.addEventListener("click", () => { ob.i = Math.max(0, ob.i - 1); renderOnboard(); });
  const n = document.getElementById("ob-next");
  if (n && opts.onNext) n.addEventListener("click", opts.onNext);
}

function obProvider() {
  const inner = `<h1>How should this run?</h1>
    <p class="sub">The default uses your local Claude Code — no API key needed.</p>
    ${providers.map((p) => `
      <div class="choice ${ob.provider === p.id ? "sel" : ""}" data-p="${p.id}">
        <div class="t">${esc(p.label)} ${p.recommended ? "· recommended" : ""}</div>
        <div class="d">${p.needsKey ? "Needs OPENROUTER_API_KEY in .env" : "No API key — uses your Claude Code login"}</div>
      </div>`).join("")}
    <div id="or-model" style="${ob.provider === "openrouter" ? "" : "display:none"}">
      <label>OpenRouter model</label><input type="text" id="f-model" value="${esc(ob.model)}" />
    </div>`;
  obShell(inner, { noBack: true, onNext: () => {
    if (ob.provider === "openrouter") ob.model = document.getElementById("f-model").value.trim() || ob.model;
    ob.i++; renderOnboard();
  }});
  app.querySelectorAll("[data-p]").forEach((el) => el.addEventListener("click", () => { ob.provider = el.dataset.p; obProvider(); }));
}

function obConsent() {
  const inner = `<h1>Before we start</h1>
    <div class="card disclaimer">
      <p><strong>This is not therapy, diagnosis, or crisis care.</strong> It's a reflective companion that
      applies psychoeducational frameworks (Heidi Priebe's work) — a supplement to, never a substitute for,
      a licensed professional.</p>
      <p>In crisis: call your local emergency number. US: call/text <strong>988</strong>. UK &amp; ROI:
      Samaritans <strong>116 123</strong>. International: findahelpline.com.</p>
      <p>Everything you share is stored <strong>locally on this machine</strong> so the companion can remember
      across sessions. You can delete it any time in Settings.</p>
      <label class="row" style="cursor:pointer"><input type="checkbox" id="f-consent" ${ob.consent ? "checked" : ""} style="width:auto;margin-right:8px" /> I understand and want to continue.</label>
    </div>`;
  obShell(inner, { onNext: () => {
    ob.consent = document.getElementById("f-consent").checked;
    if (!ob.consent) { alert("Please acknowledge to continue."); return; }
    ob.i++; renderOnboard();
  }});
}

function obName() {
  const inner = `<h1>What should I call you?</h1><p class="sub">Just a first name is fine.</p>
    <input type="text" id="f-name" value="${esc(ob.name)}" placeholder="e.g. Alex" />`;
  obShell(inner, { onNext: () => {
    ob.name = document.getElementById("f-name").value.trim();
    if (!ob.name) { alert("A name (or nickname) helps — please add one."); return; }
    ob.i++; renderOnboard();
  }});
  setTimeout(() => document.getElementById("f-name")?.focus(), 0);
}

function obGroups() {
  const mc = obOptions.mc || {};
  return [
    { key: "topics", label: "What's bringing you here? (choose any that fit)", opts: (mc.topics || []).map((t) => ({ value: t, label: t })), multi: true, ranked: false },
    { key: "readiness", label: "What do you most want right now? (tap in order of priority)", opts: mc.readiness || [], multi: true, ranked: true },
    { key: "tone", label: "How should I be with you?", opts: mc.tone || [], multi: false, ranked: false },
    { key: "emotionalStyle", label: "When a big feeling shows up, what do you tend to do? (choose any)", opts: mc.emotionalStyle || [], multi: true, ranked: false },
  ];
}

function mcSel(key, val, multi) { return multi ? ob.mc[key].includes(val) : ob.mc[key] === val; }

function chipsHtml(g) {
  const chips = g.opts.map((o) => {
    const on = mcSel(g.key, o.value, g.multi);
    const rank = g.ranked && on ? `<span class="rank">${ob.mc[g.key].indexOf(o.value) + 1}</span>` : "";
    return `<span class="mc-chip ${on ? "sel" : ""}" data-val="${esc(o.value)}">${rank}${esc(o.label)}</span>`;
  }).join("");
  const otherOn = !!(ob.mc.other[g.key] && ob.mc.other[g.key].trim());
  return chips + `<span class="mc-chip other ${otherOn ? "sel" : ""}" data-val="__other__">Other…</span>`;
}

function wireChips(g) {
  const row = app.querySelector(`[data-chips="${g.key}"]`);
  if (!row) return;
  row.querySelectorAll(".mc-chip").forEach((el) => el.addEventListener("click", () => {
    const v = el.dataset.val;
    if (v === "__other__") {
      const orow = app.querySelector(`[data-otherrow="${g.key}"]`);
      const show = orow.style.display === "none";
      orow.style.display = show ? "" : "none";
      if (show) setTimeout(() => orow.querySelector("input").focus(), 0);
      return;
    }
    if (g.multi) {
      const arr = ob.mc[g.key], idx = arr.indexOf(v);
      if (idx >= 0) arr.splice(idx, 1); else arr.push(v); // append = lowest priority (ranked)
    } else {
      ob.mc[g.key] = ob.mc[g.key] === v ? "" : v;
    }
    row.innerHTML = chipsHtml(g);
    wireChips(g);
  }));
}

function obMC(page) {
  // Two light pages instead of one wall: (1) what brings you + what you want,
  // (2) how I should be with you + how feelings tend to go.
  const all = obGroups();
  const groups = page === 1 ? all.slice(0, 2) : all.slice(2);
  const heads = page === 1
    ? { h1: "A few quick taps", sub: "Just a head start — nothing's binding, and you can skip anything. For \"what you want,\" tap in priority order." }
    : { h1: "How should this feel?", sub: "You can change all of this later, anytime." };
  const inner = `<h1>${heads.h1}</h1>
    <p class="sub">${heads.sub}</p>
    ${groups.map((g) => `
      <div class="mc-group">
        <label>${g.label}</label>
        <div class="pill-list" data-chips="${g.key}">${chipsHtml(g)}</div>
        <div class="other-row" data-otherrow="${g.key}" style="${ob.mc.other[g.key] && ob.mc.other[g.key].trim() ? "" : "display:none"}">
          <input type="text" data-otherinput="${g.key}" placeholder="Type your own…" value="${esc(ob.mc.other[g.key] || "")}" />
        </div>
      </div>`).join("")}`;
  obShell(inner, { onNext: () => { ob.i++; renderOnboard(); } });
  groups.forEach((g) => {
    wireChips(g);
    const oi = app.querySelector(`[data-otherinput="${g.key}"]`);
    if (oi) oi.addEventListener("input", () => {
      ob.mc.other[g.key] = oi.value;
      const chip = app.querySelector(`[data-chips="${g.key}"] [data-val="__other__"]`);
      if (chip) chip.classList.toggle("sel", !!oi.value.trim());
    });
  });
}

function obSection(id) {
  const sec = obSectionDefs().find((s) => s.id === id) || { id, title: "Getting to know you", seed: "Tell me a bit about yourself.", maxTurns: 2 };
  if (!ob.sec[id]) ob.sec[id] = { messages: [{ role: "assistant", content: sec.seed }] };

  // Render the shell ONCE. Sends update the chat area in place — no full re-render,
  // so the page never jumps back to the top.
  const inner = `<div class="row spread"><h1 style="margin:0">${esc(sec.title)}</h1><button id="ob-skip">Skip ahead →</button></div>
    <p class="sub">A short, open conversation so I can get to know you. Skip whenever you like.</p>
    <div id="ob-chat" class="ob-chat"></div>
    <div id="ob-composer" style="margin-top:14px"></div>`;
  obShell(inner, { right: `<span></span>` });

  const chat = document.getElementById("ob-chat");
  ob.sec[id].messages.forEach((m) => obBubble(chat, m.role, m.content));
  chat.scrollTop = chat.scrollHeight;
  document.getElementById("ob-skip").addEventListener("click", () => { ob.i++; renderOnboard(); });
  obSectionComposer(id, sec);
}

function obBubble(chat, role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  chat.appendChild(div);
  return div;
}

function obSectionComposer(id, sec) {
  const st = ob.sec[id];
  const box = document.getElementById("ob-composer");
  const userTurns = st.messages.filter((m) => m.role === "user").length;

  if (userTurns >= (sec.maxTurns || 2)) {
    box.innerHTML = `<div class="ob-done"><p class="muted" style="margin:0 0 10px">Whenever you're ready.</p><button class="primary" id="ob-continue">Continue →</button></div>`;
    document.getElementById("ob-continue").addEventListener("click", () => { ob.i++; renderOnboard(); });
    return;
  }

  box.innerHTML = `<div class="composer-inner" style="position:static;padding:0">
      <textarea id="ob-input" rows="1" placeholder="Type your answer…"></textarea>
      <button class="primary" id="ob-send">Send</button>
    </div>`;
  const input = document.getElementById("ob-input");
  const chat = document.getElementById("ob-chat");

  const send = async () => {
    const v = input.value.trim(); if (!v) return;
    input.value = ""; autoGrow(input);
    st.messages.push({ role: "user", content: v });
    obBubble(chat, "user", v);
    // Same thinking indicator as the main chat: the unfurling paper scroll.
    const typing = obBubble(chat, "assistant", "");
    typing.classList.add("loading");
    typing.appendChild(scrollLoader());
    chat.scrollTop = chat.scrollHeight;
    document.getElementById("ob-send").disabled = true;
    const finalTurn = st.messages.filter((m) => m.role === "user").length >= (sec.maxTurns || 2);
    try {
      const r = await api("POST", "/api/onboard/chat", { title: sec.title, messages: st.messages, final: finalTurn });
      typing.classList.remove("loading"); typing.textContent = r.reply;
      st.messages.push({ role: "assistant", content: r.reply });
    } catch (e) {
      typing.classList.remove("loading"); typing.textContent = "(let's keep going)";
      st.messages.push({ role: "assistant", content: "(let's keep going)" });
    }
    chat.scrollTop = chat.scrollHeight;
    obSectionComposer(id, sec); // swap to Continue if we've hit the cap
  };
  document.getElementById("ob-send").addEventListener("click", send);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  input.addEventListener("input", () => autoGrow(input));
  setTimeout(() => input.focus(), 0);
}

async function obFinish() {
  app.innerHTML = `<div class="ob-wrap center" style="padding-top:60px"><h1>Getting things ready…</h1><p class="muted spin">setting up your space</p></div>`;
  const o = ob.mc.other || {};
  const withOther = (arr, extra) => [...arr, ...(extra && extra.trim() ? [extra.trim()] : [])];
  const mergedMc = {
    topics: withOther(ob.mc.topics, o.topics),
    readiness: withOther(ob.mc.readiness, o.readiness), // ordered = priority
    tone: (o.tone && o.tone.trim()) ? o.tone.trim() : (ob.mc.tone || "balanced"),
    emotionalStyle: withOther(ob.mc.emotionalStyle, o.emotionalStyle),
  };
  try {
    await api("POST", "/api/config", {
      provider: ob.provider,
      openrouter: { model: ob.model },
      consentAcknowledged: true,
      user: { name: ob.name, tone: mergedMc.tone, openerStyle: "smart" },
    });
    await api("POST", "/api/onboard/finish", {
      mc: mergedMc,
      // The sections the person ACTUALLY chatted through (obSectionDefs), not the
      // server's static list — this used to send an empty transcript to extraction.
      sections: obSectionDefs().map((s) => ({ id: s.id, title: s.title, messages: (ob.sec[s.id] && ob.sec[s.id].messages) || [] })),
    });
    appConfig = await api("GET", "/api/config");
    ob = null;
    location.hash = "#/chat";
  } catch (e) {
    app.innerHTML = `<div class="ob-wrap"><h1>Hmm — setup didn't save</h1><p class="muted">${esc(e.message)}</p><button class="primary" id="retry">Try again</button></div>`;
    document.getElementById("retry").addEventListener("click", () => { ob.i = obSteps().length - 1; renderOnboard(); });
  }
}

// ─── Chat ──────────────────────────────────────────────────────────────────────

async function renderChat() {
  app.innerHTML = `
    <div class="session-bar">
      <div class="session-bar-inner">
        <span id="lens" class="lens">listening</span>
        <div class="bar-actions">
          <button id="focus-btn" title="Focus on the latest reply — scroll up for the rest">Focus</button>
          <button id="tone-btn" title="Adjust how I respond to you">Tone</button>
          <button id="end-btn">End session</button>
          <div id="tone-pop" class="tone-pop" style="display:none"></div>
        </div>
      </div>
    </div>
    <div id="chat-scroll"></div>
    <div class="composer"><div class="composer-inner">
      <textarea id="composer-input" rows="1" placeholder="Type here…"></textarea>
      <button class="primary" id="send-btn">Send</button>
    </div></div>`;

  const scroll = app.querySelector("#chat-scroll");
  const input = app.querySelector("#composer-input");

  // ── Focus mode: keep the latest reply crisp, let the rest recede ──────────
  const focusBtn = app.querySelector("#focus-btn");
  let focusOn = localStorage.getItem("focusMode") !== "off"; // default on
  const lastAssistant = () => { const n = scroll.querySelectorAll(".msg.assistant"); return n.length ? n[n.length - 1] : null; };
  const markFocused = () => {
    scroll.querySelectorAll(".msg.focused").forEach((n) => n.classList.remove("focused"));
    lastAssistant()?.classList.add("focused");
    scroll.classList.toggle("has-history", scroll.querySelectorAll(".msg").length > 1);
  };
  const atBottom = () => window.scrollY >= (document.documentElement.scrollHeight - window.innerHeight - 90);
  const applyFocusState = () => {
    if (!document.body.contains(scroll)) return; // stale listener after route change
    if (!focusOn) return;
    scroll.classList.toggle("revealed", !atBottom());
  };
  const setFocus = (on) => {
    focusOn = on;
    localStorage.setItem("focusMode", on ? "on" : "off");
    focusBtn.classList.toggle("on", on);
    scroll.classList.toggle("focus", on);
    markFocused();
    applyFocusState();
  };
  focusBtn.addEventListener("click", () => setFocus(!focusOn));
  // Tear down the previous chat's scroll handler so they don't pile up across
  // navigations (stale handlers firing every scroll frame = progressive lag).
  if (chatScrollHandler) window.removeEventListener("scroll", chatScrollHandler);
  // Throttle to one layout read per frame — reading scrollHeight on every raw
  // scroll event was thrashing layout and causing the scroll to stutter.
  let scrollTick = false;
  chatScrollHandler = () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => { scrollTick = false; applyFocusState(); });
  };
  window.addEventListener("scroll", chatScrollHandler, { passive: true });

  let exploring = false;
  const setModeLens = (skill, isSafety) => {
    const label = skill || (exploring ? "getting to know you" : "listening");
    setLens(exploring && !isSafety ? `exploring · ${label}` : label, isSafety, exploring);
  };

  let sess = { messages: [] };
  try { sess = await api("GET", "/api/session"); } catch {}
  exploring = sess.mode === "explore";

  if (sess.messages && sess.messages.length) {
    sess.messages.forEach((m) => addBubble(scroll, m.role, m.content, m.trace));
    setModeLens(sess.activeSkill, false);
  } else {
    let opener = { blurb: "Hi. What's on your mind?", options: [] };
    try { opener = await api("GET", "/api/opener"); } catch {}
    addBubble(scroll, "assistant", opener.blurb);
    const chips = [
      ...(opener.starters || []).map((s) => ({ label: s.label, message: s.message, cls: "starter" })),
      ...(opener.reportBacks || []).map((r) => ({ label: r.label, message: r.message, cls: "report" })),
      ...(opener.options || []),
    ];
    if (opener.canExplore) chips.push({ label: "Get to know me better →", cls: "explore", onClick: startExplore });
    if (chips.length) renderChips(scroll, chips, input);
  }
  scrollDown();
  setFocus(focusOn);
  requestAnimationFrame(applyFocusState);

  // Deep-link prefill (e.g. "Talk about this" on an experiment card in Journey).
  const prefill = sessionStorage.getItem("composerPrefill");
  if (prefill) { sessionStorage.removeItem("composerPrefill"); input.value = prefill; autoGrow(input); }

  async function startExplore() {
    // Immediate feedback: the explore opener is a real model call and can take
    // a while — switch the lens, drop the chips, and show a typing bubble now.
    app.querySelector("#chips")?.remove();
    app.querySelector("#explore-nudge")?.remove();
    exploring = true;
    setModeLens(null, false);
    const typing = addBubble(scroll, "assistant", "");
    typing.classList.add("loading");
    typing.appendChild(scrollLoader());
    markFocused(); scrollDown();
    try {
      const r = await api("POST", "/api/session/mode", { mode: "explore" });
      typing.remove();
      if (r.opener && r.opener.blurb) {
        addBubble(scroll, "assistant", r.opener.blurb);
        if (r.opener.options && r.opener.options.length) renderChips(scroll, r.opener.options, input);
      }
      markFocused(); scrollDown();
    } catch (e) {
      typing.remove();
      exploring = false;
      setModeLens(null, false);
      addBubble(scroll, "system", "Couldn't switch to an explore session: " + e.message);
    }
  }

  function renderExploreNudge() {
    app.querySelector("#explore-nudge")?.remove();
    const div = document.createElement("div");
    div.id = "explore-nudge"; div.className = "close-nudge";
    div.innerHTML = `<span>There might be something here worth slowing down and digging into together.</span>
      <button class="primary" id="explore-yes">Let's explore</button>
      <button id="explore-no">Keep talking</button>`;
    scroll.appendChild(div); scrollDown();
    div.querySelector("#explore-yes").addEventListener("click", () => { div.remove(); startExplore(); });
    div.querySelector("#explore-no").addEventListener("click", () => div.remove());
  }

  const send = async (text) => {
    const msg = (text != null ? text : input.value).trim();
    if (!msg) return;
    input.value = ""; autoGrow(input);
    app.querySelector("#chips")?.remove();
    addBubble(scroll, "user", msg);
    const typing = addBubble(scroll, "assistant", ""); typing.classList.add("loading");
    typing.appendChild(scrollLoader());
    markFocused(); scrollDown(); requestAnimationFrame(applyFocusState);
    app.querySelector("#send-btn").disabled = true;
    try {
      const r = await api("POST", "/api/chat", { message: msg });
      typing.classList.remove("loading");
      typing.remove();
      const bubble = addBubble(scroll, "assistant", r.reply, r.trace);
      exploring = r.mode === "explore";
      if (r.safety) setLens("your wellbeing comes first", true);
      else setModeLens(r.activeSkill, false);
      if (r.suggestExplore) renderExploreNudge();
      if (r.close) renderCloseNudge(scroll);
    } catch (e) {
      typing.classList.remove("loading");
      typing.textContent = "(couldn't reach the model: " + e.message + ")";
    } finally {
      app.querySelector("#send-btn").disabled = false;
      markFocused(); scrollDown(); input.focus();
      requestAnimationFrame(applyFocusState);
    }
  };

  app.querySelector("#send-btn").addEventListener("click", () => send());
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  input.addEventListener("input", () => autoGrow(input));
  app.querySelector("#end-btn").addEventListener("click", endSession);
  setupTonePopover();
  input.focus();

  async function endSession() {
    if (!confirm("End this session? I'll save a short summary to memory.")) return;
    const note = addBubble(scroll, "system", "Saving this session to memory…"); scrollDown();
    try {
      const r = await api("POST", "/api/session/end", {});
      note.textContent = r.ended ? `Saved: "${r.node.title}". You'll find it under Memory.` : "Nothing to save yet.";
    } catch (e) { note.textContent = "Couldn't save: " + e.message; }
    exploring = false;
    setLens("listening", false);
    app.querySelector("#close-nudge")?.remove();
    app.querySelector("#explore-nudge")?.remove();
  }

  function renderCloseNudge(scroll) {
    app.querySelector("#close-nudge")?.remove();
    const div = document.createElement("div");
    div.id = "close-nudge"; div.className = "close-nudge";
    div.innerHTML = `<span>This feels like a natural place to pause, if you'd like.</span>
      <button class="primary" id="wrap-btn">Wrap up &amp; save</button>
      <button id="keep-btn">Keep talking</button>`;
    scroll.appendChild(div); scrollDown();
    div.querySelector("#wrap-btn").addEventListener("click", endSession);
    div.querySelector("#keep-btn").addEventListener("click", () => div.remove());
  }
}

// Quick in-chat tone control: a button that expands into the three delivery
// dials. Saves automatically (debounced); applies to the next message.
function setupTonePopover() {
  const btn = app.querySelector("#tone-btn");
  const pop = app.querySelector("#tone-pop");
  if (!btn || !pop) return;
  let built = false, saveTimer = null;

  const readDials = () => dialsFromUser((appConfig || {}).user || {});

  function build() {
    const dials = readDials();
    pop.innerHTML = `
      <h3>How should I be with you?</h3>
      <div class="hint">Adjust anytime — saves automatically.</div>
      ${TONE_DIALS.map((d) => `
        <div class="dial">
          <div class="dial-head"><b>${d.label}</b><span id="tp-val-${d.key}">${dials[d.key]}/5</span></div>
          <input type="range" min="1" max="5" step="1" id="tp-${d.key}" value="${dials[d.key]}" />
          <div class="ends"><span>${d.lo}</span><span>${d.hi}</span></div>
        </div>`).join("")}
      <div id="tp-status"></div>`;
    for (const d of TONE_DIALS) {
      const s = pop.querySelector(`#tp-${d.key}`);
      const out = pop.querySelector(`#tp-val-${d.key}`);
      s.addEventListener("input", () => { out.textContent = `${s.value}/5`; scheduleSave(); });
    }
    pop.addEventListener("click", (e) => e.stopPropagation());
    built = true;
  }

  function refresh() {
    const dials = readDials();
    for (const d of TONE_DIALS) {
      const s = pop.querySelector(`#tp-${d.key}`); if (!s) continue;
      s.value = dials[d.key];
      pop.querySelector(`#tp-val-${d.key}`).textContent = `${dials[d.key]}/5`;
    }
    const status = pop.querySelector("#tp-status"); if (status) status.textContent = "";
  }

  function scheduleSave() {
    const status = pop.querySelector("#tp-status");
    if (status) status.textContent = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }

  async function save() {
    const toneDials = {
      inquisitive: Number(pop.querySelector("#tp-inquisitive").value),
      challenging: Number(pop.querySelector("#tp-challenging").value),
      validating: Number(pop.querySelector("#tp-validating").value),
    };
    try {
      const r = await api("POST", "/api/config", { user: { toneDials } });
      appConfig = r.config;
      pop.querySelector("#tp-status").textContent = "Saved — I'll use this from your next message.";
    } catch (e) {
      pop.querySelector("#tp-status").textContent = "Couldn't save: " + e.message;
    }
  }

  function open() { built ? refresh() : build(); pop.style.display = "block"; btn.classList.add("on"); }
  function close() { pop.style.display = "none"; btn.classList.remove("on"); }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.style.display === "none" ? open() : close();
  });
  // Close when clicking anywhere else. Remove any prior handler first so they
  // don't accumulate across chat re-renders.
  if (tonePopDocHandler) document.removeEventListener("click", tonePopDocHandler);
  tonePopDocHandler = () => {
    if (!document.body.contains(pop)) return;
    if (pop.style.display !== "none") close();
  };
  document.addEventListener("click", tonePopDocHandler);
}

/**
 * Loading indicator: a hanging paper scroll that gently unfurls and re-rolls
 * while the reply is being written. It's also a fidget — grab it and pull down
 * to unfurl it yourself; let go and it drifts back to its rhythm.
 */
function scrollLoader() {
  const el = document.createElement("div");
  el.className = "scroll-loader";
  el.innerHTML = `<span class="scroll-roll"></span><span class="scroll-sheet"></span><span class="scroll-roll"></span>`;
  const sheet = el.querySelector(".scroll-sheet");

  let t = Math.random() * Math.PI * 2; // desync multiple loaders
  let offset = 0, dragging = false, startY = 0, grabbed = 0;

  el.addEventListener("pointerdown", (e) => {
    dragging = true; startY = e.clientY; grabbed = offset;
    el.setPointerCapture(e.pointerId);
    el.classList.add("held");
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (dragging) offset = Math.max(-70, Math.min(95, grabbed + (e.clientY - startY)));
  });
  const drop = () => { dragging = false; el.classList.remove("held"); };
  el.addEventListener("pointerup", drop);
  el.addEventListener("pointercancel", drop);

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Start on the NEXT frame — the loader is created before it's appended, so a
  // synchronous first tick would see isConnected === false and never animate.
  let live = false, orphanFrames = 0;
  function tick() {
    if (el.isConnected) live = true;
    else if (live || ++orphanFrames > 300) return; // removed (or never appended) — stop
    if (!dragging) {
      t += 0.016;
      if (Math.abs(offset) > 0.5) offset *= 0.92; // eases back after a pull
    }
    const wave = reduced ? 0 : Math.sin((t * Math.PI * 2) / 3.6) * 26;
    sheet.style.height = Math.max(20, Math.min(134, 60 + wave + offset)) + "px";
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return el;
}

function addBubble(scroll, role, text, trace) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  if (role === "assistant" && trace && (trace.activeLens || trace.routerReason || trace.recalledSessionId)) {
    const wrap = document.createElement("div"); wrap.className = "think-wrap";
    const btn = document.createElement("button"); btn.className = "think-toggle"; btn.textContent = "Show thinking";
    const panel = document.createElement("div"); panel.className = "think-panel"; panel.style.display = "none";
    panel.innerHTML = traceHtml(trace);
    btn.addEventListener("click", () => {
      const open = panel.style.display !== "none";
      panel.style.display = open ? "none" : "block";
      btn.textContent = open ? "Show thinking" : "Hide thinking";
    });
    wrap.appendChild(btn); wrap.appendChild(panel);
    div.appendChild(wrap);
  }
  scroll.appendChild(div);
  return div;
}

function traceHtml(t) {
  const rows = [];
  rows.push(`<div><b>Lens:</b> ${esc(t.activeLens || "none (staying with agent-core)")}</div>`);
  if (t.routerReason) rows.push(`<div><b>Why:</b> ${esc(t.routerReason)}</div>`);
  if (t.reference) rows.push(`<div><b>Reference:</b> ${esc(t.reference)}</div>`);
  if (t.recalledSessionId) rows.push(`<div><b>Recalled session:</b> ${esc(t.recalledSessionId)}</div>`);
  if (t.consulted) rows.push(`<div><b>Consulted:</b> ${esc(t.consulted)}</div>`);
  if (t.safety) rows.push(`<div><b>Safety override:</b> yes</div>`);
  if (t.close) rows.push(`<div><b>Sensed a natural pause</b></div>`);
  return rows.join("");
}

// Chips accept plain strings (sent verbatim) or { label, message?, cls?, onClick? }.
function renderChips(scroll, options, input) {
  const div = document.createElement("div"); div.id = "chips"; div.className = "chips";
  options.forEach((o) => {
    const chip = typeof o === "string" ? { label: o } : o;
    const b = document.createElement("button");
    b.className = "chip-btn" + (chip.cls ? " " + chip.cls : "");
    b.textContent = chip.label;
    b.title = chip.label;
    b.addEventListener("click", () => {
      if (chip.onClick) { chip.onClick(); return; }
      input.value = chip.message || chip.label;
      input.dispatchEvent(new Event("input"));
      app.querySelector("#send-btn").click();
    });
    div.appendChild(b);
  });
  scroll.appendChild(div);
}

function setLens(text, isSafety, isExplore) {
  const l = app.querySelector("#lens"); if (!l) return;
  l.textContent = text; l.className = "lens" + (isSafety ? " safety" : "") + (isExplore && !isSafety ? " explore" : "");
}
function scrollDown() { requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight)); }
function autoGrow(t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 180) + "px"; }

// ─── Journey ──────────────────────────────────────────────────────────────────

const JOURNEY_SECTIONS = [
  ["timeline", "Timeline"],
  ["patterns", "Patterns"],
  ["experiments", "Experiments"],
  ["goals", "Goals"],
  ["you", "About you"],
  ["sessions", "Sessions"],
];

// Client-side relative time for display ("3 days ago"); handles stamp ids,
// plain dates, and ISO. Purely cosmetic — the agent's time sense is server-side.
function relTime(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})-(\d{2})-(\d{2}))?/);
  if (!m) return "";
  const then = new Date(+m[1], +m[2] - 1, +m[3]);
  const now = new Date();
  const d = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - then) / 86400000);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  if (d === -1) return "tomorrow";
  if (d > 1 && d < 14) return `${d} days ago`;
  if (d >= 14 && d < 60) return `about ${Math.round(d / 7)} weeks ago`;
  if (d >= 60) return `about ${Math.round(d / 30)} months ago`;
  return `in ${-d} days`;
}

const HYP_STATUS_WORDS = { forming: "just forming", testing: "testing together", supported: "confirmed with you", revised: "recently reworded", retired: "set aside" };
const GOAL_STATUS_WORDS = { active: "active", progressing: "progressing", stalled: "resting", achieved: "achieved" };

async function renderJourney(section) {
  const sec = JOURNEY_SECTIONS.some(([k]) => k === section) ? section : "timeline";
  app.innerHTML = `<h1>Journey</h1>
    <p class="sub">What we're learning together, and how it's moving over time.</p>
    <div class="journey-pills" id="jpills"></div>
    <div id="jbody"></div>`;
  const body = app.querySelector("#jbody");
  let data, timeline;
  try {
    [data, timeline] = await Promise.all([api("GET", "/api/memory"), api("GET", "/api/timeline")]);
  } catch (e) { body.innerHTML = `<p class="muted">Couldn't load: ${esc(e.message)}</p>`; return; }

  const renderers = {
    timeline: () => renderJourneyTimeline(body, timeline.entries || []),
    patterns: () => renderPatterns(body, (data.profile || {}).hypotheses || [], () => renderJourney("patterns")),
    experiments: () => renderExperiments(body, data.experiments || []),
    goals: () => renderGoals(body, (data.profile || {}).goals || []),
    you: () => renderProfileYou(body, data.profile || {}),
    sessions: () => renderSessionsList(body, data.sessions || []),
  };

  let current = sec;
  const pills = app.querySelector("#jpills");
  const draw = () => {
    pills.innerHTML = JOURNEY_SECTIONS.map(([k, label]) =>
      `<span class="mc-chip ${current === k ? "sel" : ""}" data-sec="${k}">${label}</span>`).join("");
    pills.querySelectorAll("[data-sec]").forEach((el) => el.addEventListener("click", () => {
      current = el.dataset.sec;
      history.replaceState(null, "", "#/journey/" + current); // deep-linkable, no refetch
      draw();
      renderers[current]();
    }));
  };
  draw();
  renderers[current]();
}

function renderJourneyTimeline(body, entries) {
  const upcoming = entries.filter((e) => e.type === "upcoming");
  const past = entries.filter((e) => e.type !== "upcoming");
  if (!past.length && !upcoming.length) {
    body.innerHTML = `<div class="card"><p class="muted">Your journey builds as we talk — sessions, patterns we name, experiments, and moments from your life will show up here.</p></div>`;
    return;
  }
  const DOT = { session: "session", "explore-session": "explore", "life-event": "event", milestone: "milestone", "experiment-started": "experiment", "experiment-checkin": "experiment", "experiment-concluded": "experiment", "pattern-named": "pattern", "assignment-given": "assignment", "assignment-reported": "assignment", "goal-movement": "goal" };
  let html = "";
  if (upcoming.length) {
    html += `<div class="upcoming-strip">${upcoming.map((e) =>
      `<div><strong>Coming up:</strong> ${esc(e.title)}${e.at ? ` <span class="muted">· ${esc(e.at)}</span>` : ""}</div>`).join("")}</div>`;
  }
  let lastDay = "";
  html += `<div class="tl-rail">`;
  for (const e of past) {
    const day = String(e.at).slice(0, 10);
    if (day !== lastDay) {
      lastDay = day;
      html += `<div class="tl-day">${esc(day)} <span class="muted">· ${esc(relTime(day))}</span></div>`;
    }
    const clickable = e.refKind === "session" ? ` data-tl-open="${esc(e.refId)}"` : "";
    html += `<div class="tl-entry"${clickable}>
      <span class="tl-dot ${DOT[e.type] || "session"}"></span>
      <div class="tl-body">
        <div class="tl-title">${e.type === "milestone" ? "✳ " : ""}${esc(e.title)}</div>
        ${e.detail ? `<div class="tl-detail muted">${esc(e.detail)}</div>` : ""}
      </div>
    </div>`;
    if (e.refKind === "session") html += `<div class="detail" data-detail="${esc(e.refId)}" style="display:none;margin:0 0 12px 26px"></div>`;
  }
  html += `</div>`;
  body.innerHTML = html;
  body.querySelectorAll("[data-tl-open]").forEach((n) => n.addEventListener("click", () => openSession(n.dataset.tlOpen)));
}

function renderPatterns(body, hypotheses, refresh) {
  const active = hypotheses.filter((h) => h.status !== "retired");
  const retired = hypotheses.filter((h) => h.status === "retired");
  if (!hypotheses.length) {
    body.innerHTML = `<div class="card"><p class="muted">Nothing we're noticing together yet. These build as we talk — always as guesses for you to confirm or reject, never verdicts.</p></div>`;
    return;
  }
  const card = (h, muted) => {
    const ev = (h.evidence || []).slice().reverse();
    const revs = (h.revisions || []).slice().reverse();
    const votes = h.votes || { up: 0, down: 0 };
    return `<div class="card hyp-card ${muted ? "hyp-retired" : ""}">
      <p class="hyp-statement">${esc(h.statement)}</p>
      <div class="pill-list">
        ${muted ? `<span class="tag status-${esc(h.status)}">${esc(HYP_STATUS_WORDS[h.status] || h.status)}</span>` : ""}
        <span class="tag">${esc(h.confidence)} confidence</span>
        ${h.lens ? `<span class="tag">${esc(shortSkill(h.lens))}</span>` : ""}
      </div>
      ${ev.length || revs.length ? `
        <button class="think-toggle" data-hyp-toggle>Show the evidence</button>
        <div class="hyp-detail" style="display:none">
          ${ev.map((e) => `<div class="ev-row ${e.kind === "against" ? "against" : "for"}"><span class="ev-kind">${e.kind === "against" ? "doesn't fit" : "fits"}</span> ${esc(e.note)} <span class="muted">· ${esc(relTime(e.at))}</span></div>`).join("") || `<p class="muted">No evidence recorded yet.</p>`}
          ${revs.map((r) => `<div class="ev-row rev">previously worded: “${esc(r.from)}”${r.why ? ` — reworded because ${esc(r.why)}` : ""}</div>`).join("")}
        </div>` : ""}
      ${!muted ? `<div class="vote-row">
        <button class="vote-btn up" data-hyp-vote="up" data-hyp-id="${esc(h.id)}" title="This fits — count it as evidence">▲ fits${votes.up ? ` · ${votes.up}` : ""}</button>
        <button class="vote-btn down" data-hyp-vote="down" data-hyp-id="${esc(h.id)}" title="This doesn't fit — a second down-vote sets it aside">▼ doesn't fit${votes.down ? ` · ${votes.down}` : ""}</button>
      </div>` : (votes.up || votes.down) ? `<div class="muted" style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.78rem;margin-top:8px">your votes: ▲ ${votes.up} · ▼ ${votes.down}</div>` : ""}
    </div>`;
  };
  let html = `<p class="muted" style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.86rem">Things we're noticing together — working guesses, held lightly. You're the authority: vote on what fits. Up-votes count as evidence; two down-votes set a pattern aside.</p>`;
  // Grouped by how established each noticing is, most established first.
  const GROUPS = [
    ["supported", "Confirmed with you", "Patterns you've recognized as yours."],
    ["testing", "Testing together", "Live guesses we're actively watching for."],
    ["revised", "Recently reworded", "The first wording didn't quite fit — these were refined."],
    ["forming", "Just forming", "Early impressions — not yet explored with you."],
  ];
  const byUpdated = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
  for (const [status, title, hint] of GROUPS) {
    const group = active.filter((h) => h.status === status).sort(byUpdated);
    if (!group.length) continue;
    html += `<div class="hyp-group">
      <h2 class="hyp-group-title">${title} <span class="muted">(${group.length})</span></h2>
      <p class="muted hyp-group-hint">${hint}</p>
      ${group.map((h) => card(h, false)).join("")}
    </div>`;
  }
  if (retired.length) {
    html += `<button class="think-toggle" id="retired-toggle">Set aside (${retired.length})</button>
      <div id="retired-list" style="display:none">${retired.map((h) => card(h, true)).join("")}</div>`;
  }
  body.innerHTML = html;
  body.querySelectorAll("[data-hyp-toggle]").forEach((btn) => btn.addEventListener("click", () => {
    const panel = btn.nextElementSibling;
    const open = panel.style.display !== "none";
    panel.style.display = open ? "none" : "block";
    btn.textContent = open ? "Show the evidence" : "Hide the evidence";
  }));
  const rt = body.querySelector("#retired-toggle");
  if (rt) rt.addEventListener("click", () => {
    const list = body.querySelector("#retired-list");
    list.style.display = list.style.display === "none" ? "block" : "none";
  });
  body.querySelectorAll("[data-hyp-vote]").forEach((btn) => btn.addEventListener("click", async () => {
    btn.disabled = true;
    try { await api("POST", `/api/memory/hypothesis/${encodeURIComponent(btn.dataset.hypId)}/vote`, { vote: btn.dataset.hypVote }); refresh(); }
    catch (e) { btn.disabled = false; alert("Couldn't record that: " + e.message); }
  }));
}

function renderExperiments(body, experiments) {
  if (!experiments.length) {
    body.innerHTML = `<div class="card"><p class="muted">No experiments yet. Once a pattern is well understood and you want to change it, we'll design small experiments together — new responses to try in place of old patterns.</p></div>`;
    return;
  }
  const activeExps = experiments.filter((e) => e.status !== "concluded");
  const done = experiments.filter((e) => e.status === "concluded");
  const card = (e) => {
    const last = (e.checkIns || []).slice(-1)[0];
    const meta = [
      e.startedAt ? `started ${relTime(e.startedAt)}` : `proposed ${relTime(e.proposedAt)}`,
      (e.checkIns || []).length ? `${e.checkIns.length} check-in${e.checkIns.length === 1 ? "" : "s"}` : "",
      last ? `last: “${last.note}” (${last.verdict})` : "",
    ].filter(Boolean).join(" · ");
    return `<div class="card exp-card">
      <div class="pill-list">
        <span class="tag status-${esc(e.status)}">${esc(e.status)}</span>
        ${e.strategy ? `<span class="tag">${esc(e.strategy)}</span>` : ""}
        ${e.lens ? `<span class="tag">${esc(shortSkill(e.lens))}</span>` : ""}
      </div>
      <p class="exp-swap"><span class="muted">instead of</span> ${esc(e.thePattern)}<br><span class="muted">trying</span> <strong>${esc(e.theReplacement)}</strong></p>
      <div class="muted" style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.82rem">${esc(meta)}</div>
      ${e.outcome ? `<p style="margin-bottom:0"><strong>What we learned:</strong> ${esc(e.outcome.summary)}${e.outcome.keeping === true ? " (keeping it)" : e.outcome.keeping === "adapted" ? " (adapted it)" : " (let it go)"}</p>` : `
      <div style="margin-top:10px"><button data-exp-talk="${esc(e.theReplacement)}">Talk about this</button></div>`}
    </div>`;
  };
  body.innerHTML = activeExps.map(card).join("")
    + (done.length ? `<h2 style="font-size:1.05rem">Wrapped up</h2>` + done.map(card).join("") : "");
  body.querySelectorAll("[data-exp-talk]").forEach((btn) => btn.addEventListener("click", () => {
    sessionStorage.setItem("composerPrefill", `I want to check in on the experiment we set up — "${btn.dataset.expTalk}".`);
    location.hash = "#/chat";
  }));
}

function renderGoals(body, goals) {
  const structured = (goals || []).filter((g) => g && typeof g === "object");
  if (!structured.length) {
    body.innerHTML = `<div class="card"><p class="muted">No goals on record yet — they surface naturally as we talk about what you want.</p></div>`;
    return;
  }
  const open = structured.filter((g) => g.status !== "achieved");
  const achieved = structured.filter((g) => g.status === "achieved");
  const card = (g) => {
    const recent = (g.progress || []).slice(-3).reverse();
    return `<div class="card goal-card">
      <p style="margin:0 0 8px"><strong>${esc(g.text)}</strong></p>
      <div class="pill-list"><span class="tag status-${esc(g.status)}">${esc(GOAL_STATUS_WORDS[g.status] || g.status)}</span>
        ${g.progress && g.progress.length ? `<span class="tag">last movement ${esc(relTime(g.progress[g.progress.length - 1].at))}</span>` : ""}</div>
      ${recent.length ? `<div class="goal-notes">${recent.map((p) => `<div class="ev-row"><span class="ev-kind">${esc(p.movement)}</span> ${esc(p.note || "")} <span class="muted">· ${esc(relTime(p.at))}</span></div>`).join("")}</div>` : ""}
    </div>`;
  };
  body.innerHTML = open.map(card).join("")
    + (achieved.length ? `<h2 style="font-size:1.05rem">Achieved</h2>` + achieved.map(card).join("") : "");
}

function renderProfileYou(body, p) {
  const arr = (x) => Array.isArray(x) ? x : [];
  const chips = (items) => `<div class="pill-list">${items.map((v) => `<span class="tag">${esc(v)}</span>`).join("")}</div>`;
  const still = `<p class="muted" style="font-size:0.86rem;font-family:ui-sans-serif,system-ui,sans-serif">Still learning this — it fills in as we talk.</p>`;
  const visited = Object.entries(p.skillsVisited || {}).sort((a, b) => b[1] - a[1]);

  let html = `<div class="card"><h2 style="margin-top:0">${esc(p.name || "You")}</h2>
    ${p.lifeContext ? `<p>${esc(p.lifeContext)}</p>` : still}</div>`;

  html += `<div class="card"><h2 style="margin-top:0">What matters to you</h2>
    ${arr(p.values).length ? chips(p.values) : still}</div>`;

  if (arr(p.people).length) {
    html += `<div class="card"><h2 style="margin-top:0">People in your life</h2>${p.people.map((x) =>
      `<p><strong>${esc(x.name)}</strong>${x.relationship ? ` — <span class="muted">${esc(x.relationship)}</span>` : ""}${x.notes ? `<br><span style="font-size:0.92rem">${esc(x.notes)}</span>` : ""}</p>`).join("")}</div>`;
  } else {
    html += `<div class="card"><h2 style="margin-top:0">People in your life</h2>${still}</div>`;
  }

  html += `<div class="card"><h2 style="margin-top:0">How you work</h2>
    ${p.emotionalStyle ? `<p><strong>With feelings:</strong> ${esc(p.emotionalStyle)}</p>` : ""}
    ${p.relationalContext ? `<p><strong>Relational world:</strong> ${esc(p.relationalContext)}</p>` : ""}
    ${p.readiness ? `<p><strong>What you want right now:</strong> ${esc(p.readiness)}</p>` : ""}
    ${arr(p.whatHelps).length ? `<p style="margin-bottom:4px"><strong>What has helped:</strong></p>${chips(p.whatHelps)}` : ""}
    ${!p.emotionalStyle && !p.relationalContext && !p.readiness && !arr(p.whatHelps).length ? still : ""}</div>`;

  html += `<div class="card"><h2 style="margin-top:0">Turning points</h2>
    ${arr(p.history).length ? p.history.map((h) => `<p style="margin:4px 0">· ${esc(h)}</p>`).join("") : still}</div>`;

  html += `<div class="card"><h2 style="margin-top:0">Themes we keep touching</h2>
    ${arr(p.presentingConcerns).length ? chips(p.presentingConcerns) : still}
    ${visited.length ? `<p style="margin:12px 0 4px"><strong>Lenses we've used:</strong></p><div class="pill-list">${visited.map(([k, n]) => `<span class="tag">${esc(shortSkill(k))} · ${n}</span>`).join("")}</div>` : ""}</div>`;

  body.innerHTML = html;
}

function renderSessionsList(body, sessions) {
  body.innerHTML = sessions.length
    ? `<div class="card">` + sessions.map((s) => `
        <div class="session-item">
          <div class="row spread">
            <span class="session-title" data-open="${esc(s.id)}">${s.mode === "explore" ? `<span class="tag" style="margin-right:6px">explore</span>` : ""}${esc(s.title)}</span>
            <button class="danger" data-del="${esc(s.id)}" style="padding:4px 10px;font-size:0.78rem">Delete</button>
          </div>
          <div class="muted" style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.8rem">${esc(s.date)} · ${esc(s.summary)}</div>
          <div class="pill-list">
            ${(s.skills || []).map((k) => `<span class="tag">${esc(k)}</span>`).join("")}
            ${(s.relatedSessions || []).length ? `<span class="tag">↔ ${s.relatedSessions.length} linked</span>` : ""}
          </div>
          <div class="detail" data-detail="${esc(s.id)}" style="display:none;margin-top:10px"></div>
        </div>`).join("") + `</div>`
    : `<p class="muted">No sessions saved yet. End a conversation (in Talk) to save one.</p>`;
  body.querySelectorAll("[data-open]").forEach((n) => n.addEventListener("click", () => openSession(n.dataset.open)));
  body.querySelectorAll("[data-del]").forEach((n) => n.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Delete this session from memory?")) return;
    await api("DELETE", "/api/memory/session/" + encodeURIComponent(n.dataset.del));
    renderJourney("sessions");
  }));
}

async function openSession(id) {
  const box = app.querySelector(`[data-detail="${CSS.escape(id)}"]`);
  if (!box) return;
  if (box.style.display !== "none") { box.style.display = "none"; return; }
  box.style.display = "block"; box.innerHTML = `<span class="muted spin">loading</span>`;
  try {
    const r = await api("GET", "/api/memory/session/" + encodeURIComponent(id));
    box.innerHTML = mdLite(r.markdown);
    box.querySelectorAll("[data-session]").forEach((n) => n.addEventListener("click", () => openSession(n.dataset.session)));
  } catch (e) { box.innerHTML = `<span class="muted">Couldn't load: ${esc(e.message)}</span>`; }
}

// ─── Settings ────────────────────────────────────────────────────────────────

// Legacy single-choice tone → 1–5 dials, mirroring src/templates/tone.js so the
// sliders show sensible positions for configs created before the dials existed.
const LEGACY_TONE_TO_DIALS = {
  support: { inquisitive: 3, challenging: 1, validating: 5 },
  balanced: { inquisitive: 3, challenging: 3, validating: 3 },
  challenge: { inquisitive: 4, challenging: 5, validating: 2 },
};
const TONE_DIALS = [
  { key: "inquisitive", label: "Inquisitive", lo: "Rarely asks", hi: "Probes deeply" },
  { key: "challenging", label: "Challenging", lo: "Just accepts", hi: "Pushes back hard" },
  { key: "validating", label: "Validating", lo: "Matter-of-fact", hi: "Warmly affirming" },
];

function dialsFromUser(u) {
  const raw = (u && u.toneDials) || LEGACY_TONE_TO_DIALS[u && u.tone] || { inquisitive: 3, challenging: 3, validating: 3 };
  const clamp = (n) => Math.min(5, Math.max(1, Math.round(Number(n)) || 3));
  return { inquisitive: clamp(raw.inquisitive), challenging: clamp(raw.challenging), validating: clamp(raw.validating) };
}

async function renderSettings() {
  const cfg = appConfig || {};
  const u = cfg.user || {};
  const dials = dialsFromUser(u);
  if (!providers) { try { providers = await api("GET", "/api/providers"); } catch { providers = []; } }
  app.innerHTML = `
    <h1>Settings</h1>
    <div class="card">
      <h2 style="margin-top:0">About you</h2>
      <label>Name</label><input type="text" id="s-name" value="${esc(u.name || "")}" />
      <label>How should I be with you?</label>
      <p class="muted" style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.82rem;margin:2px 0 10px">Dial each from 1 to 5.</p>
      ${TONE_DIALS.map((d) => `
        <div class="tone-dial" style="margin-bottom:12px">
          <div class="row" style="justify-content:space-between;align-items:baseline">
            <label style="margin:0">${d.label}</label>
            <span class="muted" id="s-dial-val-${d.key}" style="font-variant-numeric:tabular-nums">${dials[d.key]}/5</span>
          </div>
          <input type="range" min="1" max="5" step="1" id="s-dial-${d.key}" value="${dials[d.key]}" style="width:100%" />
          <div class="row" style="justify-content:space-between"><span class="muted" style="font-size:0.76rem">${d.lo}</span><span class="muted" style="font-size:0.76rem">${d.hi}</span></div>
        </div>`).join("")}
      <label>How should I open our conversations?</label>
      <select id="s-opener">
        <option value="smart" ${u.openerStyle === "smart" || !u.openerStyle ? "selected" : ""}>Smart — pick up where we left off</option>
        <option value="blurb" ${u.openerStyle === "blurb" ? "selected" : ""}>A warm line + one question</option>
        <option value="open" ${u.openerStyle === "open" ? "selected" : ""}>Just "what's on your mind?"</option>
      </select>
      <div class="row" style="margin-top:14px"><button class="primary" id="s-save-you">Save</button><span id="s-msg1" class="toast"></span></div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Model provider</h2>
      <select id="s-provider">
        ${providers.map((p) => `<option value="${p.id}" ${cfg.provider === p.id ? "selected" : ""}>${esc(p.label)}${p.needsKey && !p.available ? " (no key set)" : ""}</option>`).join("")}
      </select>
      <div class="row" style="margin-top:12px"><button class="primary" id="s-save-prov">Save</button><span id="s-msg2" class="toast"></span></div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Privacy</h2>
      <p class="muted" style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.86rem">All memory lives locally in this app's <code>memory/</code> folder. Deleting is permanent.</p>
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <button class="danger" id="s-wipe">Delete all memory</button>
        <button id="s-newperson" title="Runs onboarding again for someone else — the current profile and sessions are archived, never inherited">Set up for a new person</button>
      </div>
    </div>`;

  // Live-update the "n/5" readout as each slider moves.
  for (const d of TONE_DIALS) {
    const slider = app.querySelector(`#s-dial-${d.key}`);
    const out = app.querySelector(`#s-dial-val-${d.key}`);
    slider.addEventListener("input", () => { out.textContent = `${slider.value}/5`; });
  }

  app.querySelector("#s-save-you").addEventListener("click", async () => {
    try {
      const toneDials = {
        inquisitive: Number(app.querySelector("#s-dial-inquisitive").value),
        challenging: Number(app.querySelector("#s-dial-challenging").value),
        validating: Number(app.querySelector("#s-dial-validating").value),
      };
      const r = await api("POST", "/api/config", { user: {
        name: app.querySelector("#s-name").value.trim(),
        toneDials,
        openerStyle: app.querySelector("#s-opener").value,
      }});
      appConfig = r.config; app.querySelector("#s-msg1").textContent = "Saved.";
    } catch (e) { app.querySelector("#s-msg1").textContent = "Error: " + e.message; }
  });
  app.querySelector("#s-save-prov").addEventListener("click", async () => {
    try { const r = await api("POST", "/api/config", { provider: app.querySelector("#s-provider").value }); appConfig = r.config; app.querySelector("#s-msg2").textContent = "Saved."; }
    catch (e) { app.querySelector("#s-msg2").textContent = "Error: " + e.message; }
  });
  app.querySelector("#s-wipe").addEventListener("click", async () => {
    if (!confirm("Delete ALL saved memory (profile + every session)? This cannot be undone.")) return;
    try { await api("DELETE", "/api/memory"); alert("Memory cleared."); } catch (e) { alert("Error: " + e.message); }
  });
  app.querySelector("#s-newperson").addEventListener("click", async () => {
    if (!confirm("Start onboarding for a new person? The current profile, patterns, goals and sessions will be archived (kept on disk, not deleted) the moment the new onboarding finishes.")) return;
    try {
      const r = await api("POST", "/api/config", { setupComplete: false, consentAcknowledged: false, user: { name: "" } });
      appConfig = r.config;
      ob = null;
      location.hash = "#/onboard";
    } catch (e) { alert("Error: " + e.message); }
  });
}

// ─── Therapist dashboard (viz + insights, no LLM) ──────────────────────────────

const THERAPIST_SECTIONS = [
  ["network", "Network"],
  ["lenses", "Lenses"],
  ["signals", "Signals"],
  ["timeline", "Timeline"],
];

async function renderTherapist(section) {
  const sec = THERAPIST_SECTIONS.some(([k]) => k === section) ? section : "network";
  app.innerHTML = `<h1>Therapist view</h1>
    <p class="sub">A read-only lens on the referential network and what it reveals. Local, single-user — no clinical claims.</p>
    <div class="journey-pills" id="thpills"></div>
    <div id="ther"></div>`;
  const box = app.querySelector("#ther");
  let data;
  try { data = await api("GET", "/api/memory"); } catch (e) { box.innerHTML = `<p class="muted">Couldn't load: ${esc(e.message)}</p>`; return; }

  const sessions = data.sessions || [];
  const skillsIdx = data.skills || {};
  const profile = data.profile || {};

  if (!sessions.length) {
    app.querySelector("#thpills").remove();
    box.innerHTML = `<div class="card"><p class="muted">No sessions yet — the network builds as conversations are saved.</p></div>`;
    return;
  }

  const renderers = {
    network: () => {
      box.innerHTML = `<div class="card"><h2 style="margin-top:0">Referential network</h2>
        <p class="muted" style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.82rem">Lenses (large) linked to the sessions that used them; faint lines join related sessions. Click a node to inspect.</p>
        <div id="graph"></div><div id="node-detail" class="node-detail muted">Click a node to inspect.</div>
      </div>`;
      drawGraph(sessions, skillsIdx);
    },
    lenses: () => {
      box.innerHTML = `<div class="card"><h2 style="margin-top:0">Most-used lenses</h2><div id="freq"></div></div>
        <div class="card"><h2 style="margin-top:0">Lenses that co-occur</h2><div id="cooc"></div></div>`;
      drawFreq(skillsIdx, sessions);
      drawCooc(sessions);
    },
    signals: () => {
      box.innerHTML = `<div class="card"><h2 style="margin-top:0">Profile signals</h2><div id="psig"></div></div>`;
      drawProfileSignals(profile);
    },
    timeline: () => {
      box.innerHTML = `<div class="card"><h2 style="margin-top:0">Timeline</h2><div id="tl"></div></div>`;
      drawTimeline(sessions);
    },
  };

  let current = sec;
  const pills = app.querySelector("#thpills");
  const draw = () => {
    pills.innerHTML = THERAPIST_SECTIONS.map(([k, label]) =>
      `<span class="mc-chip ${current === k ? "sel" : ""}" data-sec="${k}">${label}</span>`).join("");
    pills.querySelectorAll("[data-sec]").forEach((el) => el.addEventListener("click", () => {
      current = el.dataset.sec;
      history.replaceState(null, "", "#/therapist/" + current);
      draw();
      renderers[current]();
    }));
  };
  draw();
  renderers[current]();
}

function drawGraph(sessions, skillsIdx) {
  const W = 680, H = 460, cx = W / 2, cy = H / 2;
  const skillNames = Object.keys(skillsIdx);
  if (!skillNames.length) { document.getElementById("graph").innerHTML = `<p class="muted">No lenses recorded yet.</p>`; return; }
  const Rskill = 175, Rsession = 95;

  // Skill positions on outer ring.
  const skillPos = {};
  skillNames.forEach((s, i) => {
    const a = (i / skillNames.length) * Math.PI * 2 - Math.PI / 2;
    skillPos[s] = { x: cx + Rskill * Math.cos(a), y: cy + Rskill * Math.sin(a), count: (skillsIdx[s].sessions || []).length };
  });
  // Session positions: near the centroid of their skills, pulled inward.
  const sessPos = {};
  sessions.forEach((s, i) => {
    const pts = (s.skills || []).map((k) => skillPos[k]).filter(Boolean);
    let x = cx, y = cy;
    if (pts.length) { x = pts.reduce((a, p) => a + p.x, 0) / pts.length; y = pts.reduce((a, p) => a + p.y, 0) / pts.length; x = cx + (x - cx) * 0.5; y = cy + (y - cy) * 0.5; }
    else { const a = (i / sessions.length) * Math.PI * 2; x = cx + Rsession * Math.cos(a); y = cy + Rsession * Math.sin(a); }
    sessPos[s.id] = { x, y };
  });

  let edges = "";
  sessions.forEach((s) => (s.skills || []).forEach((k) => {
    if (skillPos[k]) edges += `<line x1="${sessPos[s.id].x}" y1="${sessPos[s.id].y}" x2="${skillPos[k].x}" y2="${skillPos[k].y}" class="edge" data-sess="${esc(s.id)}" data-skill="${esc(k)}" />`;
  }));
  sessions.forEach((s) => (s.relatedSessions || []).forEach((r) => {
    if (sessPos[r] && s.id < r) edges += `<line x1="${sessPos[s.id].x}" y1="${sessPos[s.id].y}" x2="${sessPos[r].x}" y2="${sessPos[r].y}" class="edge related" />`;
  }));

  let nodes = "";
  skillNames.forEach((s) => {
    const p = skillPos[s], r = 9 + Math.min(p.count, 6) * 3;
    nodes += `<g class="gnode" data-type="skill" data-id="${esc(s)}"><circle cx="${p.x}" cy="${p.y}" r="${r}" class="skill-node" />
      <text x="${p.x}" y="${p.y - r - 5}" class="glabel">${esc(shortSkill(s))}</text></g>`;
  });
  sessions.forEach((s) => {
    const p = sessPos[s.id];
    nodes += `<g class="gnode" data-type="session" data-id="${esc(s.id)}"><circle cx="${p.x}" cy="${p.y}" r="6" class="session-node" /></g>`;
  });

  document.getElementById("graph").innerHTML =
    `<div class="graph-scroll"><svg viewBox="0 0 ${W} ${H}" class="graph-svg">${edges}${nodes}</svg></div>`;

  const detail = document.getElementById("node-detail");
  document.querySelectorAll(".gnode").forEach((g) => g.addEventListener("click", () => {
    const type = g.dataset.type, id = g.dataset.id;
    document.querySelectorAll(".gnode").forEach((x) => x.classList.remove("hi"));
    document.querySelectorAll(".edge").forEach((e) => e.classList.remove("hi"));
    g.classList.add("hi");
    if (type === "skill") {
      const ids = (skillsIdx[id].sessions || []);
      document.querySelectorAll(`.edge[data-skill="${cssEsc(id)}"]`).forEach((e) => e.classList.add("hi"));
      detail.innerHTML = `<strong>${esc(id)}</strong> — used in ${ids.length} session(s):<br>${ids.map((x) => esc(sessionTitle(sessions, x))).join("<br>")}`;
    } else {
      const s = sessions.find((x) => x.id === id);
      document.querySelectorAll(`.edge[data-sess="${cssEsc(id)}"]`).forEach((e) => e.classList.add("hi"));
      detail.innerHTML = `<strong>${esc(s.title)}</strong> <span class="muted">(${esc(s.date)})</span><br>${esc(s.summary)}<br>Lenses: ${(s.skills || []).map(esc).join(", ") || "—"}`;
    }
  }));
}

function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&"); }
function shortSkill(s) { return s.replace(/-and-.*$/, "…").replace(/-/g, " "); }
function sessionTitle(sessions, id) { const s = sessions.find((x) => x.id === id); return s ? s.title : id; }

function drawFreq(skillsIdx, sessions) {
  const rows = Object.entries(skillsIdx).map(([k, v]) => [k, (v.sessions || []).length]).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  document.getElementById("freq").innerHTML = rows.length
    ? rows.map(([k, n]) => `<div class="bar-row"><span class="bar-label">${esc(shortSkill(k))}</span><span class="bar"><span class="bar-fill" style="width:${(n / max) * 100}%"></span></span><span class="bar-n">${n}</span></div>`).join("")
    : `<p class="muted">—</p>`;
}

function drawCooc(sessions) {
  const pairs = {};
  sessions.forEach((s) => {
    const sk = [...new Set(s.skills || [])].sort();
    for (let i = 0; i < sk.length; i++) for (let j = i + 1; j < sk.length; j++) {
      const key = sk[i] + " + " + sk[j]; pairs[key] = (pairs[key] || 0) + 1;
    }
  });
  const rows = Object.entries(pairs).sort((a, b) => b[1] - a[1]);
  document.getElementById("cooc").innerHTML = rows.length
    ? rows.map(([k, n]) => `<div class="row spread" style="padding:4px 0"><span>${esc(k.replace(/-/g, " "))}</span><span class="tag">${n}×</span></div>`).join("")
    : `<p class="muted">No lenses have co-occurred yet — they appear here once a session touches more than one.</p>`;
}

function drawProfileSignals(p) {
  const arr = (x) => Array.isArray(x) ? x : [];
  const goalText = (g) => (g && typeof g === "object") ? `${g.text}${g.status && g.status !== "active" ? ` [${g.status}]` : ""}` : g;
  const bits = [];
  if (p.lifeContext) bits.push(["Life context", p.lifeContext]);
  if (arr(p.values).length) bits.push(["Values", p.values.join("; ")]);
  if (arr(p.goals).length) bits.push(["Goals", p.goals.map(goalText).join("; ")]);
  if (p.relationalContext) bits.push(["Relational context", p.relationalContext]);
  if (p.emotionalStyle) bits.push(["Emotional style", p.emotionalStyle]);
  if (p.readiness) bits.push(["Readiness", p.readiness]);
  if (arr(p.history).length) bits.push(["Turning points", p.history.join("; ")]);
  if (arr(p.whatHelps).length) bits.push(["What's helped", p.whatHelps.join("; ")]);
  if (arr(p.presentingConcerns).length) bits.push(["Recurring concerns", p.presentingConcerns.join("; ")]);
  if (arr(p.redFlags).length) bits.push(["Flags", p.redFlags.join("; ")]);
  if (arr(p.people).length) bits.push(["People on record", p.people.map((x) => x.name + (x.relationship ? ` (${x.relationship})` : "")).join(", ")]);
  const hyps = arr(p.hypotheses);
  const hypTable = hyps.length
    ? `<p style="margin-bottom:4px"><strong>Working hypotheses:</strong></p>` + hyps.map((h) =>
        `<div class="row spread" style="padding:2px 0;font-size:0.88rem"><span>${esc(h.statement)}</span><span class="tag">${esc(h.status)} · ${esc(h.confidence)} · ${(h.evidence || []).length} ev.</span></div>`).join("")
    : "";
  document.getElementById("psig").innerHTML = (bits.length || hyps.length)
    ? bits.map(([k, v]) => `<p><strong>${esc(k)}:</strong> ${esc(v)}</p>`).join("") + hypTable
    : `<p class="muted">Signals accumulate as sessions are saved.</p>`;
}

function drawTimeline(sessions) {
  document.getElementById("tl").innerHTML = sessions.map((s) =>
    `<div class="session-item"><div class="row spread"><strong>${esc(s.title)}</strong><span class="muted">${esc(s.date)}</span></div>
     <div class="pill-list">${(s.skills || []).map((k) => `<span class="tag">${esc(shortSkill(k))}</span>`).join("")}</div></div>`
  ).join("");
}
