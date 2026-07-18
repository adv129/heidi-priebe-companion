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

/**
 * One chat turn with progressive bubbles. Asks for SSE; onChunk(text, i) fires
 * per bubble as the model writes. Resolves with the full done payload. If the
 * server answers plain JSON instead (errors, or a build without SSE), the
 * chunks are synthesized from the payload so callers never see the difference.
 */
async function streamChat(body, onChunk) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error || `${res.status}`);
    (data.chunks && data.chunks.length ? data.chunks : [data.reply]).forEach((c, i) => onChunk(c, i));
    return data;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let donePayload = null;
  const handleFrame = (frame) => {
    let event = "message", data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    if (event === "chunk") onChunk(payload.text, payload.i);
    else if (event === "done") donePayload = payload;
    else if (event === "error") throw new Error(payload.error || "stream error");
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      handleFrame(buf.slice(0, idx)); // may throw on event: error — bubbles up
      buf = buf.slice(idx + 2);
    }
  }
  if (donePayload) return donePayload;
  throw new Error("connection lost mid-reply");
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
    ? [["/therapist", "Brief"], ["/therapist/data", "Data"], ["/settings", "Settings"]]
    : [["/chat", "Talk"], ["/journey", "Journey"], ["/settings", "Settings"]];
  // Longest matching prefix wins, so "/therapist/data" doesn't also light up "/therapist".
  const best = links.reduce((b, [h]) => ((cur === h || cur.startsWith(h + "/")) && h.length > b.length ? h : b), "");
  nav.innerHTML = links.map(([h, t]) => `<a href="#${h}" class="${h === best ? "active" : ""}">${t}</a>`).join("");
}

async function handleRoute() {
  if (!appConfig) { try { appConfig = await api("GET", "/api/config"); } catch { appConfig = {}; } }
  let path = location.hash.replace("#", "") || "/chat";
  if (path === "/memory" || path.startsWith("/memory/")) { location.hash = "#/journey"; return; }
  if (!appConfig.setupComplete && path !== "/onboard") { location.hash = "#/onboard"; return; }
  if (appConfig.setupComplete && path === "/onboard") { location.hash = "#/chat"; return; }
  buildChrome();
  if (path.startsWith("/journey")) { await renderJourney(path.split("/")[2] || ""); return; }
  if (path.startsWith("/therapist")) { await renderTherapist(path.split("/").slice(2)); return; }
  await (routes[path] || renderChat)();
}

window.addEventListener("hashchange", handleRoute);
window.addEventListener("DOMContentLoaded", handleRoute);

// ─── Onboarding ────────────────────────────────────────────────────────────────

let ob = null;

// Each topic the person can pick maps to a tailored opening question for its
// conversational section. Custom/unmapped topics get a generic seed.
const MAX_TOPIC_SECTIONS = 2; // cap answer-driven sections to avoid fatigue

/** The server's questionnaire (each entry: {id, q, options:[{label, signal, title?, seed?}]}). */
function obQuizCatalog() {
  return (obOptions && obOptions.mc && Array.isArray(obOptions.mc.quiz)) ? obOptions.mc.quiz : [];
}

/** The answers that lit a territory up, strongest first: [{q, label, signal, title, seed}]. */
function obQuizSignals() {
  const out = [];
  for (const q of obQuizCatalog()) {
    const label = ob.mc.quiz[q.id];
    if (!label) continue;
    const opt = q.options.find((o) => o.label === label);
    if (opt && opt.signal > 0 && opt.title) out.push({ q: q.q, label, signal: opt.signal, title: opt.title, seed: opt.seed });
  }
  return out.sort((a, b) => b.signal - a.signal);
}

// Conversational sections, EASY → DEEPER: start with plain day-to-day life,
// then the questions their questionnaire answers turned into, then people, and
// only at the end the (explicitly optional) why-now question. All skippable.
function obSectionDefs() {
  const seen = new Set();
  const issueSecs = [];
  for (const sig of obQuizSignals()) {
    if (seen.has(sig.title)) continue;
    seen.add(sig.title);
    issueSecs.push({ id: "t" + issueSecs.length, title: sig.title, seed: sig.seed, maxTurns: 2 });
    if (issueSecs.length >= MAX_TOPIC_SECTIONS) break;
  }
  return [
    { id: "today", title: "Life right now", seed: "Let's start easy. What does day-to-day life look like for you at the moment — work, school, where you're living, that kind of thing?", maxTurns: 2 },
    ...issueSecs,
    { id: "why-now", title: "Why now", seed: "Last one — and only if you feel like going there: what made now feel like the moment to start doing this kind of work?", maxTurns: 2 },
  ];
}

function obSteps() {
  // The structured add-your-people step sits between the issue conversations
  // and the final (optional) why-now question.
  const secs = obSectionDefs().map((s) => "section:" + s.id);
  const whyNow = secs.pop();
  return ["provider", "consent", "name", "quiz", "style", ...secs, "people", whyNow, "finish"];
}

// Progress chips across the wizard (collapses the chat sections into one stage).
function obProgressHtml() {
  const stages = [
    ["provider|consent", "Setup"],
    ["name", "Name"],
    ["quiz|style", "Quick taps"],
    ["section:|people", "A short chat"],
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
  if (!ob) ob = { i: 0, qi: 0, provider: "claude-p", model: "openai/gpt-4o-mini", consent: false, name: "", mc: { topics: [], quiz: {}, readiness: [], tone: "balanced", emotionalStyle: [], other: { topics: "", readiness: "", tone: "", emotionalStyle: "" } }, sec: {}, people: [] };

  const steps = obSteps();
  const cur = steps[ob.i];

  if (cur === "provider") return obProvider();
  if (cur === "consent") return obConsent();
  if (cur === "name") return obName();
  if (cur === "quiz") return obQuiz();
  if (cur === "style") return obStyle();
  if (cur === "people") return obPeople();
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
    { key: "readiness", label: "What do you most want right now? (tap in order of priority)", opts: mc.readiness || [], multi: true, ranked: true },
    { key: "tone", label: "How should I be with you?", opts: mc.tone || [], multi: false, ranked: false },
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

// The check-in questionnaire: one broad, easy question per screen, one tap per
// answer, auto-advancing. The answers quietly decide what we talk about next.
function obQuiz() {
  const quiz = obQuizCatalog();
  if (ob.qi == null) ob.qi = 0;
  if (!quiz.length || ob.qi >= quiz.length) {
    ob.qi = null;
    ob.i++;
    renderOnboard();
    return;
  }
  const q = quiz[ob.qi];
  const chosen = ob.mc.quiz[q.id];
  const inner = `<div class="quiz-meta">A quick check-in · ${ob.qi + 1} of ${quiz.length}</div>
    <h1 style="font-size:clamp(1.5rem, 4vw, 2.1rem)">${esc(q.q)}</h1>
    <p class="sub">One tap — whatever's closest. There are no wrong answers.</p>
    ${q.options.map((o) => `<div class="choice ${chosen === o.label ? "sel" : ""}" data-opt="${esc(o.label)}"><div class="t">${esc(o.label)}</div></div>`).join("")}
    <div class="row spread" style="margin-top:20px">
      <button id="quiz-back">Back</button>
      <button id="quiz-skip">Skip this one</button>
    </div>`;
  app.innerHTML = `<div class="ob-wrap">${obProgressHtml()}${inner}</div>`;
  app.querySelectorAll("[data-opt]").forEach((el) => el.addEventListener("click", () => {
    ob.mc.quiz[q.id] = el.dataset.opt;
    app.querySelectorAll("[data-opt]").forEach((x) => x.classList.remove("sel"));
    el.classList.add("sel");
    setTimeout(() => { ob.qi++; obQuiz(); }, 180); // brief beat so the tap lands visibly
  }));
  document.getElementById("quiz-skip").addEventListener("click", () => {
    delete ob.mc.quiz[q.id];
    ob.qi++;
    obQuiz();
  });
  document.getElementById("quiz-back").addEventListener("click", () => {
    if (ob.qi > 0) { ob.qi--; obQuiz(); }
    else { ob.qi = 0; ob.i = Math.max(0, ob.i - 1); renderOnboard(); }
  });
}

// The two style questions: what they want (in priority order) and tone.
function obStyle() {
  const groups = obGroups();
  const inner = `<h1>How should this feel?</h1>
    <p class="sub">For "what you want," tap in priority order. You can change all of this later, anytime.</p>
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

// Shared person-entry form (used by onboarding and the Talk-screen exercise).
// Renders into `box`; calls onAdd(person) for each added person.
function personForm(box, people, onChange) {
  const draw = () => {
    box.innerHTML = `
      ${people.length ? `<div class="person-cards">${people.map((p, i) => `
        <div class="person-card">
          <strong>${esc(p.name)}</strong>${p.relationship ? ` <span class="muted">· ${esc(p.relationship)}</span>` : ""}${p.workingOn ? ` <span class="tag status-testing">working on it</span>` : ""}
          ${p.notes ? `<div class="muted" style="font-size:0.85rem">${esc(p.notes)}</div>` : ""}
          <button class="person-remove" data-rm="${i}" title="Remove">×</button>
        </div>`).join("")}</div>` : ""}
      <div class="person-form">
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <input type="text" id="pf-name" placeholder="Name" style="flex:1;min-width:120px" />
          <input type="text" id="pf-rel" placeholder="Who they are to you (mom, partner, best friend…)" style="flex:2;min-width:180px" />
        </div>
        <textarea id="pf-notes" rows="2" placeholder="How are they showing up in your life right now?"></textarea>
        <label class="row" style="cursor:pointer;font-family:var(--font-ui);font-size:0.86rem;gap:8px">
          <input type="checkbox" id="pf-working" style="width:auto" /> This is a relationship I'm working on
        </label>
        <button id="pf-add">Add ${people.length ? "another" : "them"}</button>
      </div>`;
    box.querySelector("#pf-add").addEventListener("click", () => {
      const name = box.querySelector("#pf-name").value.trim();
      if (!name) { box.querySelector("#pf-name").focus(); return; }
      people.push({
        name,
        relationship: box.querySelector("#pf-rel").value.trim(),
        notes: box.querySelector("#pf-notes").value.trim(),
        workingOn: box.querySelector("#pf-working").checked,
      });
      if (onChange) onChange();
      draw();
      setTimeout(() => box.querySelector("#pf-name")?.focus(), 0);
    });
    box.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => {
      people.splice(Number(b.dataset.rm), 1);
      if (onChange) onChange();
      draw();
    }));
  };
  draw();
}

// Structured "people in your life" step — add real people instead of being
// asked to describe your relational world in the abstract.
function obPeople() {
  const inner = `<h1>The people in your life</h1>
    <p class="sub">Add whoever matters — family, partner, friends, even someone complicated. A name and a line is plenty, and you can skip this entirely.</p>
    <div id="ob-people"></div>`;
  obShell(inner, { nextLabel: ob.people.length ? "Next" : "Skip for now", onNext: () => { ob.i++; renderOnboard(); } });
  personForm(document.getElementById("ob-people"), ob.people, () => {
    const n = app.querySelector("#ob-next");
    if (n) n.textContent = ob.people.length ? "Next" : "Skip for now";
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
  const quiz = obQuizCatalog();
  const mergedMc = {
    // The check-in answers that lit something up (used for gating + concerns)…
    topics: obQuizSignals().map((s) => `${s.q} → ${s.label}`),
    // …and the full answer set for the extraction's context.
    quizAnswers: quiz.map((q) => ob.mc.quiz[q.id] ? { q: q.q, a: ob.mc.quiz[q.id] } : null).filter(Boolean),
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
      people: ob.people,
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
    sess.messages.forEach((m) => {
      // Chunked assistant messages restore as one bubble each, trace on the
      // last only. Old messages (no chunks) render exactly as before.
      const parts = m.role === "assistant" && m.chunks && m.chunks.length ? m.chunks : [m.content];
      parts.forEach((p, i) => addBubble(scroll, m.role, p, i === parts.length - 1 ? m.trace : null));
    });
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
    if (chips.length) renderChips(scroll, chips, input);
    if (opener.exercises && opener.exercises.length) renderExercises(scroll, opener.exercises);
  }
  scrollDown();
  setFocus(focusOn);
  requestAnimationFrame(applyFocusState);

  // Deep-link prefill (e.g. "Talk about this" on an experiment card in Journey).
  const prefill = sessionStorage.getItem("composerPrefill");
  if (prefill) { sessionStorage.removeItem("composerPrefill"); input.value = prefill; autoGrow(input); }

  const send = async (text) => {
    const msg = (text != null ? text : input.value).trim();
    if (!msg) return;
    input.value = ""; autoGrow(input);
    app.querySelector("#chips")?.remove();
    app.querySelector("#exercises")?.remove();
    addBubble(scroll, "user", msg);
    const typing = addBubble(scroll, "assistant", ""); typing.classList.add("loading");
    typing.appendChild(scrollLoader());
    markFocused(); scrollDown(); requestAnimationFrame(applyFocusState);
    app.querySelector("#send-btn").disabled = true;

    // Bubbles stream in progressively: first chunk replaces the loader and a
    // small persistent typing bubble trails the conversation; each later chunk
    // slots in before it; done removes it and pins the trace on the last bubble.
    let typingBubble = null; // the between-chunks indicator (after first chunk)
    let lastBubble = null;   // last assistant bubble of this turn
    const onChunk = (chunkText) => {
      if (!typingBubble) {
        typing.remove(); // the initial loader bubble
        typingBubble = addBubble(scroll, "assistant", "");
        typingBubble.classList.add("loading");
        typingBubble.appendChild(scrollLoader());
      }
      const b = addBubble(scroll, "assistant", chunkText);
      scroll.insertBefore(b, typingBubble);
      lastBubble = b;
      markFocused(); scrollDown(); requestAnimationFrame(applyFocusState);
    };

    try {
      const r = await streamChat({ message: msg }, onChunk);
      if (typingBubble) typingBubble.remove();
      else typing.remove(); // no chunk ever arrived (shouldn't happen, but never strand the loader)
      if (!lastBubble && r.reply) lastBubble = addBubble(scroll, "assistant", r.reply);
      if (lastBubble) attachTrace(lastBubble, r.trace);
      exploring = r.mode === "explore";
      if (r.safety) setLens("your wellbeing comes first", true);
      else setModeLens(r.activeSkill, false);
      if (r.close) renderCloseNudge(scroll);
    } catch (e) {
      const errBubble = typingBubble || typing;
      errBubble.classList.remove("loading");
      errBubble.replaceChildren();
      errBubble.textContent = "(couldn't reach the model: " + e.message + ")";
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
  if (role === "assistant") attachTrace(div, trace);
  scroll.appendChild(div);
  return div;
}

/** Attach the collapsible "Show thinking" trace panel to an assistant bubble. */
function attachTrace(div, trace) {
  if (!trace || !(trace.activeLens || trace.routerReason || trace.recalledSessionId)) return;
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

// Fill-in-your-picture exercises under the opener chips: light, optional ways
// to add the depth onboarding deliberately skips (people, goals).
function renderExercises(scroll, list) {
  const wrap = document.createElement("div");
  wrap.id = "exercises";
  wrap.className = "exercises";
  wrap.innerHTML = `<div class="ex-hint">While you're here — a little goes a long way:</div>
    <div class="chips" style="margin-top:0">${list.map((e) => `<button class="chip-btn ex" data-ex="${esc(e.kind)}">${esc(e.label)}</button>`).join("")}</div>
    <div class="ex-panel" style="display:none"></div>`;
  scroll.appendChild(wrap);
  const panel = wrap.querySelector(".ex-panel");

  const done = (btn, msg) => {
    panel.innerHTML = `<div class="card ex-card"><p style="margin:0">${esc(msg)}</p></div>`;
    btn.remove();
    setTimeout(() => { panel.style.display = "none"; panel.innerHTML = ""; }, 2600);
  };

  wrap.querySelectorAll("[data-ex]").forEach((btn) => btn.addEventListener("click", () => {
    panel.style.display = "block";
    if (btn.dataset.ex === "people") {
      const people = [];
      panel.innerHTML = `<div class="card ex-card">
        <h3 style="margin:0 0 4px">The people in your life</h3>
        <p class="muted" style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.84rem;margin:0 0 10px">A name and a line is plenty — I'll hold the rest as we talk.</p>
        <div class="ex-people"></div>
        <div class="row" style="gap:8px;margin-top:10px"><button class="primary" data-save>Save</button><button data-close>Close</button></div>
      </div>`;
      personForm(panel.querySelector(".ex-people"), people, null);
      panel.querySelector("[data-save]").addEventListener("click", async () => {
        if (!people.length) { panel.querySelector("#pf-name")?.focus(); return; }
        try {
          await api("POST", "/api/profile/add", { people });
          done(btn, `Got it — ${people.length === 1 ? people[0].name + " is" : people.length + " people are"} part of the picture now.`);
        } catch (e) { alert("Couldn't save: " + e.message); }
      });
      panel.querySelector("[data-close]").addEventListener("click", () => { panel.style.display = "none"; panel.innerHTML = ""; });
    } else if (btn.dataset.ex === "goal") {
      panel.innerHTML = `<div class="card ex-card">
        <h3 style="margin:0 0 4px">Something you're working toward</h3>
        <p class="muted" style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.84rem;margin:0 0 10px">In your own words — big or small. We'll track how it moves over time.</p>
        <textarea class="ex-goal" rows="2" placeholder="e.g. stop disappearing in relationships, actually rest on weekends…"></textarea>
        <div class="row" style="gap:8px;margin-top:10px"><button class="primary" data-save>Save</button><button data-close>Close</button></div>
      </div>`;
      panel.querySelector("[data-save]").addEventListener("click", async () => {
        const text = panel.querySelector(".ex-goal").value.trim();
        if (!text) { panel.querySelector(".ex-goal").focus(); return; }
        try {
          await api("POST", "/api/profile/add", { goals: [text] });
          done(btn, "Saved — you'll find it under Journey → Goals, and we can work on it any time.");
        } catch (e) { alert("Couldn't save: " + e.message); }
      });
      panel.querySelector("[data-close]").addEventListener("click", () => { panel.style.display = "none"; panel.innerHTML = ""; });
      setTimeout(() => panel.querySelector(".ex-goal")?.focus(), 0);
    }
  }));
}

function setLens(text, isSafety, isExplore) {
  const l = app.querySelector("#lens"); if (!l) return;
  l.textContent = text; l.className = "lens" + (isSafety ? " safety" : "") + (isExplore && !isSafety ? " explore" : "");
}
function scrollDown() { requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight)); }
function autoGrow(t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 180) + "px"; }

// ─── Journey ──────────────────────────────────────────────────────────────────

const JOURNEY_SECTIONS = [
  ["now", "Now"],
  ["timeline", "Timeline"],
  ["patterns", "Patterns"],
  ["goals", "Goals"],
  ["you", "About you"],
  ["sessions", "Sessions"],
];

// Whole days from a stamp id / date string to today: positive = past, negative
// = upcoming, null = unparseable. Purely cosmetic — time sense is server-side.
function daysAgo(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})-(\d{2})-(\d{2}))?/);
  if (!m) return null;
  const then = new Date(+m[1], +m[2] - 1, +m[3]);
  const now = new Date();
  return Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - then) / 86400000);
}

function trunc(s, n) {
  const t = String(s == null ? "" : s);
  return t.length > n ? t.slice(0, n).trim() + "…" : t;
}

// Client-side relative time for display ("3 days ago"); handles stamp ids,
// plain dates, and ISO.
function relTime(s) {
  const d = daysAgo(s);
  if (d === null) return "";
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
  // Old experiments/homework deep links fall through to "now" — their content
  // lives in the thread cards there.
  const sec = JOURNEY_SECTIONS.some(([k]) => k === section) ? section : "now";
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
    now: () => renderNow(body, data, timeline.entries || [], select),
    timeline: () => renderJourneyTimeline(body, timeline.entries || []),
    patterns: () => renderPatterns(body, (data.profile || {}).hypotheses || [], () => renderJourney("patterns")),
    goals: () => renderGoals(body, (data.profile || {}).goals || []),
    you: () => renderProfileYou(body, data.profile || {}),
    sessions: () => renderSessionsList(body, data.sessions || []),
  };

  let current = sec;
  const pills = app.querySelector("#jpills");
  const select = (k) => {
    current = k;
    history.replaceState(null, "", "#/journey/" + current); // deep-linkable, no refetch
    draw();
    renderers[current]();
  };
  const draw = () => {
    pills.innerHTML = JOURNEY_SECTIONS.map(([k, label]) =>
      `<span class="mc-chip ${current === k ? "sel" : ""}" data-sec="${k}">${label}</span>`).join("");
    pills.querySelectorAll("[data-sec]").forEach((el) => el.addEventListener("click", () => select(el.dataset.sec)));
  };
  draw();
  renderers[current]();
}

// ── The "Now" landing view: one thread per active pattern, with the
// experiments and homework linked to it nested underneath. Pure aggregation
// over what /api/memory and /api/timeline already return — no new data.

const RECENT_DAYS = 14;   // concluded experiments / reported homework stay in-thread this long
const MOTION_DAYS = 30;   // goal movement / upcoming events horizon

/**
 * Group active hypotheses with their linked experiments + homework.
 * Order: supported → testing → forming (→ revised), most recently updated
 * first within a group; capped at 4 cards. "Revised" counts as active only
 * while something open/running still hangs off it; retired never shows.
 */
function buildThreads(data) {
  const profile = data.profile || {};
  const hyps = profile.hypotheses || [];
  const experiments = data.experiments || [];
  const assignments = profile.assignments || [];
  const recent = (at) => { const d = daysAgo(at); return d !== null && d >= 0 && d <= RECENT_DAYS; };

  const expsFor = (id) => experiments.filter((e) => e.hypothesisId === id);
  const hwFor = (id) => assignments.filter((a) => a.linkedHypothesisId === id);

  const active = hyps.filter((h) => {
    if (h.status === "supported" || h.status === "testing" || h.status === "forming") return true;
    if (h.status === "revised") {
      return expsFor(h.id).some((e) => e.status === "running") || hwFor(h.id).some((a) => a.status === "open");
    }
    return false; // retired (and anything unknown) never threads
  });
  const ORDER = { supported: 0, testing: 1, forming: 2, revised: 3 };
  active.sort((a, b) =>
    (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || String(b.updatedAt).localeCompare(String(a.updatedAt)));

  const shown = active.slice(0, 4).map((h) => ({
    hyp: h,
    experiments: expsFor(h.id).filter((e) =>
      e.status === "running" || e.status === "proposed" ||
      (e.status === "concluded" && e.outcome && recent(e.outcome.at))),
    homework: hwFor(h.id).filter((a) =>
      a.status === "open" || (a.status === "reported" && a.report && recent(a.report.at))),
  }));
  return { shown, moreCount: active.length - shown.length };
}

const NOW_SIGNAL_WORDS = { supports: "fits the pattern", complicates: "doesn't quite fit", unclear: "hard to say" };

function nowExpRow(e) {
  if (e.status === "running") {
    const day = (daysAgo(e.startedAt) ?? 0) + 1;
    const last = (e.checkIns || []).slice(-1)[0];
    return `<div class="thread-row"><span class="t-kind exp">Experiment</span><span class="t-body">day ${day}: trying <strong>${esc(e.theReplacement)}</strong> instead of ${esc(e.thePattern)} — ${last ? `last check-in: ${esc(String(last.verdict).replace(/-/g, " "))}` : "no check-in yet"}</span></div>`;
  }
  if (e.status === "concluded") {
    return `<div class="thread-row"><span class="t-kind exp">Experiment</span><span class="t-body">concluded: ${esc(trunc(e.outcome && e.outcome.summary, 110))}</span></div>`;
  }
  return `<div class="thread-row"><span class="t-kind exp">Experiment</span><span class="t-body">proposed — waiting on you: “${esc(trunc(e.theReplacement, 70))}”</span></div>`;
}

function nowHwRow(a) {
  if (a.status === "reported" && a.report) {
    const signal = NOW_SIGNAL_WORDS[a.report.hypothesisSignal] || NOW_SIGNAL_WORDS.unclear;
    return `<div class="thread-row"><span class="t-kind hw">Homework</span><span class="t-body">reported: “${esc(trunc(a.report.findings, 80))}” — ${signal}</span></div>`;
  }
  return `<div class="thread-row"><span class="t-kind hw">Homework</span><span class="t-body">open: ${esc(a.text)}</span></div>`;
}

function renderNow(body, data, tlEntries, select) {
  const profile = data.profile || {};
  const experiments = data.experiments || [];
  const assignments = profile.assignments || [];
  const { shown, moreCount } = buildThreads(data);

  // ── Header counts ──
  const runningCount = experiments.filter((e) => e.status === "running").length;
  const openHwCount = assignments.filter((a) => a.status === "open").length;
  const counts = [];
  if (shown.length) counts.push(`${shown.length} thread${shown.length === 1 ? "" : "s"} in motion`);
  if (runningCount) counts.push(`${runningCount} experiment${runningCount === 1 ? "" : "s"} running`);
  if (openHwCount) counts.push(`${openHwCount} homework open`);

  // ── Also in motion ──
  const shownIds = new Set(shown.map((t) => t.hyp.id));
  // Anything active that isn't visible inside a thread card (dangling link,
  // retired parent, or a pattern beyond the cap) surfaces here instead.
  const looseExps = experiments.filter((e) => e.status === "running" && !shownIds.has(e.hypothesisId));
  const looseHw = assignments.filter((a) => a.status === "open" && !shownIds.has(a.linkedHypothesisId));
  const movedGoals = (profile.goals || []).filter((g) => {
    if (!g || typeof g !== "object" || !(g.progress || []).length) return false;
    const d = daysAgo(g.progress[g.progress.length - 1].at);
    return d !== null && d >= 0 && d <= MOTION_DAYS;
  });
  const upcoming = tlEntries.filter((e) => {
    if (e.type !== "upcoming") return false;
    const d = daysAgo(e.at);
    return d !== null && d <= 0 && d >= -MOTION_DAYS;
  });

  const nothingInMotion = !shown.length && !looseExps.length && !looseHw.length && !movedGoals.length && !upcoming.length;

  // ── Compose ──
  let html = `<div class="now-head">
    <h2 class="now-title">Right now</h2>
    ${counts.length ? `<p class="now-counts">${esc(counts.join(" · "))}</p>` : ""}
  </div>`;

  if (nothingInMotion) {
    html += `<div class="card"><p class="muted">Nothing in motion yet. As we talk, patterns we notice together — and anything you agree to try — will gather here.</p></div>`;
  }

  html += shown.map((t) => {
    const h = t.hyp;
    const rows = [...t.experiments.map(nowExpRow), ...t.homework.map(nowHwRow)];
    return `<div class="card thread-card">
      <div class="thread-head">
        <p class="thread-statement">${esc(h.statement)}</p>
        <span class="tag status-${esc(h.status)}">${esc(HYP_STATUS_WORDS[h.status] || h.status)}</span>
      </div>
      ${rows.length ? `<div class="thread-rows">${rows.join("")}</div>` : ""}
      <div class="thread-actions"><button data-th-talk="${esc(h.statement)}">Talk about this →</button></div>
    </div>`;
  }).join("");

  if (moreCount > 0) {
    html += `<button class="now-more" data-go="patterns">+${moreCount} more pattern${moreCount === 1 ? "" : "s"} →</button>`;
  }

  const alsoRows = [
    ...movedGoals.map((g) => {
      const last = g.progress[g.progress.length - 1];
      const word = last.movement === "holding" ? "holding recently" : `moved ${esc(last.movement)} recently`;
      return `<div class="thread-row"><span class="t-kind goal">Goal</span><span class="t-body">${esc(g.text)} — ${word}</span></div>`;
    }),
    ...upcoming.map((e) => {
      const away = -daysAgo(e.at);
      const rel = away === 0 ? "today" : away === 1 ? "tomorrow" : `${away} days away`;
      return `<div class="thread-row"><span class="t-kind ev">Coming up</span><span class="t-body">${esc(e.title)} — ${esc(String(e.at).slice(0, 10))} (${rel})</span></div>`;
    }),
    ...looseExps.map(nowExpRow),
    ...looseHw.map(nowHwRow),
  ];
  if (alsoRows.length) {
    html += `<div class="now-label">Also in motion</div>
      <div class="card also-card">${alsoRows.join("")}</div>`;
  }

  html += `<div class="now-label">Dig deeper</div>
    <div class="dig-row">
      <button class="mc-chip" data-go="timeline">Timeline</button>
      <button class="mc-chip" data-go="patterns">All patterns</button>
      <button class="mc-chip" data-go="goals">Goals</button>
      <button class="mc-chip" data-go="sessions">Sessions</button>
      <button class="mc-chip" data-go="you">About you</button>
    </div>`;

  body.innerHTML = html;
  body.querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => select(el.dataset.go)));
  body.querySelectorAll("[data-th-talk]").forEach((btn) => btn.addEventListener("click", () => {
    sessionStorage.setItem("composerPrefill", `I want to dig into the pattern we've been noticing — "${btn.dataset.thTalk}".`);
    location.hash = "#/chat";
  }));
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

// Opener styles. Legacy values (smart/blurb/open) map to "pickup" when rendering.
const OPENER_STYLES = [
  { value: "pickup", label: "Pick up where we left off", hint: "A warm line about last time, plus a few directions to choose from." },
  { value: "homework", label: "Check in on my homework first", hint: "Opens with what you agreed to notice or try." },
  { value: "patterns", label: "Dig into a pattern", hint: "Offers the patterns we've been noticing — pick one to unpack." },
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
  const openerStyle = OPENER_STYLES.some((o) => o.value === u.openerStyle) ? u.openerStyle : "pickup"; // legacy smart/blurb/open → pickup
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
        ${OPENER_STYLES.map((o) => `<option value="${o.value}" ${o.value === openerStyle ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
      </select>
      <p class="muted" id="s-opener-hint" style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.82rem;margin:6px 0 0">${esc(OPENER_STYLES.find((o) => o.value === openerStyle).hint)}</p>
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

  // Keep the sub-copy honest about whichever opener style is selected.
  const openerSel = app.querySelector("#s-opener");
  openerSel.addEventListener("change", () => {
    const o = OPENER_STYLES.find((x) => x.value === openerSel.value) || OPENER_STYLES[0];
    app.querySelector("#s-opener-hint").textContent = o.hint;
  });

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

// ─── Therapist mode: the brief ─────────────────────────────────────────────────
//
// Therapist mode is built around one artifact: a BRIEF the person composes and
// SENDS to their real-world therapist. #/therapist = home (presets + past
// briefs) → compose/<preset> (window + section/item toggles → narrative review)
// → view/<id> (print-ready page). #/therapist/data keeps the network/lens
// visualizations as an on-screen exploration (they don't print).

const PRESET_META = {
  "first-meeting": {
    name: "First meeting intro",
    desc: "Introduce yourself before therapy starts: who you are, the people in your life, patterns you've been noticing together, goals, and what helps.",
  },
  "pre-session": {
    name: "Pre-session update",
    desc: "A quick 1–2 page update your therapist can read in two minutes: how the picture has changed, what's happened in your life, and where there's movement.",
  },
};

// Transient composer state — privacy choices are made fresh for every brief,
// never silently inherited from the last one.
let bc = null;

async function renderTherapist(parts = []) {
  const [sec, arg] = Array.isArray(parts) ? parts : [parts];
  if (sec === "compose" && PRESET_META[arg]) return renderBriefComposer(arg);
  if (sec === "view" && arg) return renderBriefView(arg);
  if (sec === "data") return renderTherapistData(arg || "network");
  return renderBriefHome();
}

// ── Home: presets + past briefs ──

async function renderBriefHome() {
  bc = null;
  app.innerHTML = `<h1>Therapist brief</h1>
    <p class="sub">Compose a document to send to your therapist — you choose exactly what's shared, review every word, then print or save as a PDF.</p>
    <div id="bhome"></div>`;
  const box = app.querySelector("#bhome");
  let data;
  try { data = await api("GET", "/api/briefs"); } catch (e) { box.innerHTML = `<p class="muted">Couldn't load: ${esc(e.message)}</p>`; return; }

  box.innerHTML = `
    <div class="preset-row">
      ${Object.entries(PRESET_META).map(([k, m]) => `
        <a class="card preset-card" href="#/therapist/compose/${k}">
          <h3>${esc(m.name)}</h3>
          <p class="muted">${esc(m.desc)}</p>
          <span class="mc-chip sel">Compose →</span>
        </a>`).join("")}
    </div>
    <h2>Past briefs</h2>
    <div id="blist">${data.briefs.length ? "" : `<p class="muted">Nothing yet. Saved briefs stay here so you can reopen and reprint exactly what you sent.</p>`}</div>`;

  const list = box.querySelector("#blist");
  for (const b of data.briefs) {
    const el = document.createElement("div");
    el.className = "card brief-row";
    el.innerHTML = `<div class="row spread">
        <div><strong>${esc(PRESET_META[b.preset] ? PRESET_META[b.preset].name : b.preset)}</strong>
          <span class="muted"> · ${esc(String(b.at).slice(0, 10))}${b.windowStart ? ` · covering since ${esc(b.windowStart)}` : ""}</span></div>
        <div class="row" style="gap:8px">
          <a class="mc-chip" href="#/therapist/view/${esc(b.id)}">Open</a>
          <button class="mc-chip b-del" title="Delete this saved brief">✕</button>
        </div></div>`;
    el.querySelector(".b-del").addEventListener("click", async () => {
      if (!confirm("Delete this saved brief? The data it was built from stays in your memory.")) return;
      try { await api("DELETE", "/api/brief/" + b.id); renderBriefHome(); } catch (e) { alert(e.message); }
    });
    list.appendChild(el);
  }
}

// ── Composer ──

async function renderBriefComposer(preset) {
  const meta = PRESET_META[preset];
  bc = { preset, windowStart: null, winChoice: null, composed: null, on: {}, excluded: {}, narrative: null, narrativeEdited: false, stage: "compose" };
  app.innerHTML = `<h1>${esc(meta.name)}</h1>
    <p class="sub">Untick anything you'd rather keep private — only what's ticked reaches the document and the narrative.</p>
    <div id="bwin"></div>
    <div id="bcomp"><p class="muted">Composing…</p></div>
    <div id="bact" class="brief-actions"></div>`;

  if (preset === "pre-session") {
    let home; try { home = await api("GET", "/api/briefs"); } catch { home = {}; }
    renderWindowPicker(home.defaultWindow || {}); // sets bc.windowStart to the default choice
  }
  await loadBriefPreview();
}

function localDateStr(daysAgo) {
  const t = new Date();
  t.setDate(t.getDate() - daysAgo);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

function renderWindowPicker(dw) {
  const box = app.querySelector("#bwin");
  const choices = [];
  if (dw.source === "last-brief") choices.push({ id: "last", label: `Since your last brief (${dw.windowStart})`, ws: dw.windowStart });
  choices.push({ id: "2w", label: "Last 2 weeks", ws: localDateStr(14) });
  choices.push({ id: "1m", label: "Last month", ws: localDateStr(30) });
  bc.winChoice = choices[0].id;
  bc.windowStart = choices[0].ws;

  const draw = () => {
    box.innerHTML = `<div class="card compose-card"><h3 style="margin-top:0">Covering what period?</h3>
      <div class="journey-pills" style="margin:0">
        ${choices.map((c) => `<span class="mc-chip ${bc.winChoice === c.id ? "sel" : ""}" data-w="${c.id}">${esc(c.label)}</span>`).join("")}
        <span class="mc-chip ${bc.winChoice === "custom" ? "sel" : ""}" data-w="custom">Custom…</span>
        <input type="date" id="bdate" class="b-date-input ${bc.winChoice === "custom" ? "" : "hidden"}" value="${esc(bc.winChoice === "custom" ? (bc.windowStart || "") : "")}" max="${localDateStr(0)}">
      </div></div>`;
    box.querySelectorAll("[data-w]").forEach((el) => el.addEventListener("click", async () => {
      bc.winChoice = el.dataset.w;
      if (el.dataset.w === "custom") { draw(); box.querySelector("#bdate").focus(); return; }
      bc.windowStart = choices.find((c) => c.id === el.dataset.w).ws;
      draw();
      await loadBriefPreview();
    }));
    const di = box.querySelector("#bdate");
    di.addEventListener("change", async () => {
      if (!di.value) return;
      bc.windowStart = di.value;
      await loadBriefPreview();
    });
  };
  draw();
}

async function loadBriefPreview() {
  const box = app.querySelector("#bcomp");
  box.innerHTML = `<p class="muted">Composing…</p>`;
  try {
    bc.composed = await api("POST", "/api/brief/preview", { preset: bc.preset, windowStart: bc.windowStart });
  } catch (e) { box.innerHTML = `<p class="muted">Couldn't compose: ${esc(e.message)}</p>`; return; }
  bc.on = {}; bc.excluded = {};
  for (const s of bc.composed.sections) bc.on[s.key] = !!(s.defaultOn || s.alwaysOn);
  drawComposer();
  drawComposerActions();
}

function sectionParts(sec) { return briefSectionParts(sec) || {}; }
function sectionEmpty(parts) { return !parts.intro && !parts.outro && (!parts.items || !parts.items.length); }

function drawComposer() {
  bc.stage = "compose";
  const win = app.querySelector("#bwin");
  if (win) win.classList.remove("hidden");
  const box = app.querySelector("#bcomp");

  box.innerHTML = bc.composed.sections.map((sec) => {
    const parts = sectionParts(sec);
    const empty = sectionEmpty(parts);
    if (empty) bc.on[sec.key] = false;
    const ex = new Set((bc.excluded[sec.key] || []).map(String));

    let itemsHtml = "";
    if (parts.items) {
      let lastGroup = null;
      for (const it of parts.items) {
        if (it.group && it.group !== lastGroup) { itemsHtml += `<h4 class="b-group">${esc(it.group)}</h4>`; lastGroup = it.group; }
        const off = ex.has(String(it.id));
        itemsHtml += `<label class="b-pick ${off ? "off" : ""}">
          <input type="checkbox" data-sec="${esc(sec.key)}" data-id="${esc(it.id)}" ${off ? "" : "checked"}>
          <div class="b-pick-body">${it.html}</div></label>`;
      }
    }

    return `<div class="card compose-card ${bc.on[sec.key] ? "" : "sec-off"}" data-card="${esc(sec.key)}">
      <label class="row b-sec-head">
        <input type="checkbox" data-secon="${esc(sec.key)}" ${bc.on[sec.key] ? "checked" : ""} ${sec.alwaysOn || empty ? "disabled" : ""}>
        <h3>${esc(sec.title)}</h3>
      </label>
      ${empty
        ? `<p class="muted">(nothing ${bc.preset === "pre-session" ? "in this period" : "here yet"})</p>`
        : `<div class="b-sec-body">${parts.intro || ""}${itemsHtml}${parts.outro || ""}</div>`}
    </div>`;
  }).join("");

  box.querySelectorAll("[data-secon]").forEach((el) => el.addEventListener("change", () => {
    bc.on[el.dataset.secon] = el.checked;
    el.closest(".compose-card").classList.toggle("sec-off", !el.checked);
  }));
  box.querySelectorAll("[data-sec][data-id]").forEach((el) => el.addEventListener("change", () => {
    const key = el.dataset.sec, id = String(el.dataset.id);
    const list = (bc.excluded[key] || []).filter((x) => String(x) !== id);
    if (!el.checked) list.push(id);
    bc.excluded[key] = list;
    el.closest(".b-pick").classList.toggle("off", !el.checked);
  }));
}

function drawComposerActions() {
  const act = app.querySelector("#bact");
  act.innerHTML = `
    <button class="mc-chip sel" id="bgen">Generate narrative →</button>
    <button class="mc-chip" id="bskip">Continue without narrative</button>`;
  act.querySelector("#bgen").addEventListener("click", () => generateNarrativeAndReview());
  act.querySelector("#bskip").addEventListener("click", () => { bc.narrative = null; bc.narrativeEdited = false; drawReview(false); });
}

function briefSelection() {
  return {
    preset: bc.preset,
    windowStart: bc.windowStart,
    sections: bc.composed.sections.filter((s) => bc.on[s.key]).map((s) => s.key),
    excluded: bc.excluded,
  };
}

async function generateNarrativeAndReview(regen) {
  const btn = app.querySelector(regen ? "#bregen" : "#bgen");
  if (btn) { btn.textContent = "Writing…"; btn.disabled = true; }
  try {
    const r = await api("POST", "/api/brief/narrative", briefSelection());
    bc.narrative = r.narrative;
    bc.narrativeEdited = false;
    drawReview(false);
  } catch (e) {
    if (regen) {
      alert("Couldn't regenerate: " + e.message);
      if (btn) { btn.textContent = "Regenerate"; btn.disabled = false; }
    } else {
      drawReview(true);
    }
  }
}

/** The composed data, filtered by the CURRENT toggles — mirror of the server's exclusion filter, for the WYSIWYG preview. */
function briefClientFiltered() {
  const drop = (key, arr) => (arr || []).filter((it) => !(bc.excluded[key] || []).map(String).includes(String(it.id)));
  const sections = bc.composed.sections.filter((s) => bc.on[s.key]).map((s) => {
    const c = JSON.parse(JSON.stringify(s));
    if (c.items) c.items = drop(c.key, c.items);
    if (c.goals) c.goals = drop(c.key, c.goals);
    if (c.people) c.people = drop(c.key, c.people);
    if (c.weeks) c.weeks = c.weeks.map((w) => ({ ...w, items: drop(c.key, w.items) })).filter((w) => w.items.length);
    if (c.occurred) c.occurred = drop(c.key, c.occurred);
    if (c.horizon) c.horizon = drop(c.key, c.horizon);
    return c;
  });
  return { ...bc.composed, sections };
}

function drawReview(genFailed) {
  bc.stage = "review";
  const win = app.querySelector("#bwin");
  if (win) win.classList.add("hidden");
  app.querySelector("#bact").innerHTML = "";
  const box = app.querySelector("#bcomp");

  box.innerHTML = `
    <div class="card compose-card">
      <div class="row spread" style="align-items:center">
        <h3 style="margin:0">Opening narrative</h3>
        <button class="mc-chip" id="beditsel">← Edit selection</button>
      </div>
      ${genFailed
        ? `<p class="b-warn">Couldn't generate the narrative — you can write one yourself below, or save without it.</p>`
        : `<p class="muted b-ai-note">AI-composed from exactly what you ticked. Edit freely — nothing goes to your therapist unseen.</p>`}
      <textarea id="bnarr" class="b-narr" placeholder="(no narrative — write your own here, or leave empty)">${esc(bc.narrative || "")}</textarea>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="mc-chip" id="bregen">Regenerate</button>
        <button class="mc-chip" id="bremove">Remove narrative</button>
        <span style="flex:1"></span>
        <button class="mc-chip sel" id="bsave">Save &amp; open print view</button>
      </div>
    </div>
    <h2 style="margin-top:24px">How it will read</h2>
    <p class="sub">The narrative above will open the document; these sections follow.</p>
    ${briefDocHtml(briefClientFiltered(), null)}`;

  const ta = box.querySelector("#bnarr");
  const size = () => { ta.style.height = "auto"; ta.style.height = Math.max(120, ta.scrollHeight) + "px"; };
  size();
  ta.addEventListener("input", () => { bc.narrative = ta.value; bc.narrativeEdited = true; size(); });

  box.querySelector("#beditsel").addEventListener("click", () => { drawComposer(); drawComposerActions(); });
  box.querySelector("#bregen").addEventListener("click", () => {
    if (bc.narrativeEdited && !confirm("Regenerating replaces your edits. Continue?")) return;
    generateNarrativeAndReview(true);
  });
  box.querySelector("#bremove").addEventListener("click", () => {
    bc.narrative = null; bc.narrativeEdited = false; ta.value = ""; size();
  });
  box.querySelector("#bsave").addEventListener("click", async () => {
    const btn = box.querySelector("#bsave");
    btn.textContent = "Saving…"; btn.disabled = true;
    const narrative = (ta.value || "").trim() || null;
    try {
      const r = await api("POST", "/api/brief", { ...briefSelection(), narrative, narrativeEdited: bc.narrativeEdited });
      bc = null;
      location.hash = "#/therapist/view/" + r.id;
    } catch (e) {
      alert("Couldn't save: " + e.message);
      btn.textContent = "Save & open print view"; btn.disabled = false;
    }
  });
}

// ── Print view (saved snapshot) ──

async function renderBriefView(id) {
  app.innerHTML = `<div class="brief-actions no-print">
      <a class="mc-chip" href="#/therapist">← Briefs</a>
      <span style="flex:1"></span>
      <button class="mc-chip sel" id="bprint">Print / Save as PDF</button>
    </div>
    <div id="bdoc"><p class="muted">Loading…</p></div>`;
  let b;
  try { b = await api("GET", "/api/brief/" + id); } catch (e) { app.querySelector("#bdoc").innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  app.querySelector("#bdoc").innerHTML = briefDocHtml(b.data, b.narrative);
  document.getElementById("bprint").addEventListener("click", () => window.print());
}

// ── Shared document renderer (composer preview AND print view — WYSIWYG) ──

function briefDocHtml(data, narrative) {
  if (!data) return `<p class="muted">Nothing to show.</p>`;
  const secs = (data.sections || []).map((sec) => {
    const parts = sectionParts(sec);
    if (sectionEmpty(parts)) return "";
    let items = "";
    if (parts.items) {
      let lastGroup = null;
      for (const it of parts.items) {
        if (it.group && it.group !== lastGroup) { items += `<h4 class="b-group">${esc(it.group)}</h4>`; lastGroup = it.group; }
        items += it.html;
      }
    }
    return `<section class="brief-section${sec.key === "flags" ? " b-flags" : ""}">
      <h2>${esc(sec.title)}</h2>${parts.intro || ""}${items}${parts.outro || ""}</section>`;
  }).join("");

  const narrHtml = narrative
    ? `<section class="brief-section b-opening">
        <h2>${data.preset === "pre-session" ? "What's moved" : "Opening picture"}</h2>
        <p class="b-ai-label">AI-composed from self-report; reviewed by the client.</p>
        ${esc(narrative).split(/\n+/).filter((p) => p.trim()).map((p) => `<p>${p}</p>`).join("")}
      </section>`
    : "";

  return `<article class="brief-doc">
    <header class="brief-head">
      <h1>${esc(data.header.title)}</h1>
      <p class="b-headline">${esc(data.header.clientName)}${data.header.clientName ? " · " : ""}${esc(data.header.prepared)}${data.header.windowLine ? `<br>${esc(data.header.windowLine)}` : ""}</p>
      <p class="b-provenance">${esc(data.provenance)}</p>
    </header>
    ${narrHtml}
    ${secs}
    <footer class="brief-footer">${esc(data.footer)}</footer>
  </article>`;
}

function hypItemHtml(h) {
  const meta = [h.status, `${h.confidence} confidence`, h.sinceRel ? `noticed ${h.sinceRel}` : ""].filter(Boolean).join(" · ");
  const votes = h.votes
    ? [h.votes.up ? `client endorsed ×${h.votes.up}` : "", h.votes.down ? `client rejected ×${h.votes.down}` : ""].filter(Boolean).join(", ")
    : "";
  return `<div class="b-item b-hyp">
    <p class="b-statement">“${esc(h.statement)}”${h.change ? ` <span class="tag">${esc(h.change)}</span>` : ""}</p>
    <p class="b-meta">${esc(meta)}${votes ? ` · ${esc(votes)}` : ""}</p>
    ${(h.evidenceFor || []).map((e) => `<p class="b-ev">supporting: ${esc(e.note)} <span class="b-date">(${esc(e.date)})</span></p>`).join("")}
    ${(h.evidenceAgainst || []).map((e) => `<p class="b-ev b-ev-against">counter: ${esc(e.note)} <span class="b-date">(${esc(e.date)})</span></p>`).join("")}
    ${h.revisionNote ? `<p class="b-ev b-rev">${esc(h.revisionNote)}</p>` : ""}
  </div>`;
}

/**
 * Per-section render parts: { intro, items:[{id, html, group?}], outro }.
 * Used identically by the composer (items get checkboxes) and the document.
 */
function briefSectionParts(sec) {
  const P = (t, cls) => (t ? `<p${cls ? ` class="${cls}"` : ""}>${esc(t)}</p>` : "");
  const UL = (arr) => (arr && arr.length ? `<ul class="b-ul">${arr.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "");

  switch (sec.key) {
    case "snapshot": {
      const kv = [
        ["How I handle feelings", sec.emotionalStyle],
        ["My relational world", sec.relationalContext],
        ["What I want from this work", sec.readiness],
        ["What matters to me", (sec.values || []).join(", ")],
      ].filter(([, v]) => v);
      return { intro: P(sec.lifeContext) + kv.map(([k, v]) => `<p class="b-kv"><strong>${esc(k)}:</strong> ${esc(v)}</p>`).join("") };
    }
    case "concerns-goals":
      return {
        intro: sec.concerns && sec.concerns.length ? `<p class="b-kv"><strong>What brings me in:</strong></p>${UL(sec.concerns)}` : "",
        items: (sec.goals || []).map((g) => ({
          id: g.id,
          html: `<div class="b-item"><p><strong>${esc(g.text)}</strong> <span class="tag">${esc(g.statusWord)}</span></p>${g.movement ? `<p class="b-meta">${esc(g.movement)}</p>` : ""}</div>`,
        })),
      };
    case "people":
      return {
        items: (sec.people || []).map((x) => ({
          id: x.id,
          html: `<div class="b-item"><p><strong>${esc(x.name)}</strong>${x.relationship ? ` — ${esc(x.relationship)}` : ""}${x.workingOn ? ` <em class="b-note">a relationship I'm working on</em>` : ""}</p>${x.notes ? `<p class="b-meta">${esc(x.notes)}</p>` : ""}</div>`,
        })),
      };
    case "history":
      return { items: (sec.items || []).map((it) => ({ id: it.id, html: `<div class="b-item"><p>${esc(it.text)}</p></div>` })) };
    case "patterns":
      return {
        intro: sec.items && sec.items.length ? P(sec.framing, "b-framing") : "",
        items: (sec.items || []).map((h) => ({ id: h.id, html: hypItemHtml(h) })),
      };
    case "whathelps":
      return {
        intro: UL(sec.items),
        outro: (sec.learned || []).map((e) =>
          `<div class="b-item"><p>Tried <strong>${esc(e.replacement)}</strong> instead of “${esc(e.pattern)}” — learned: ${esc(e.summary)} <span class="tag">${esc(e.keeping)}</span></p></div>`).join(""),
      };
    case "flags":
      return {
        intro: P(sec.note, "b-meta"),
        items: (sec.items || []).map((it) => ({
          id: it.id,
          html: `<div class="b-item"><p>${it.kind === "childhood" ? `<em>Childhood context I volunteered:</em> ` : ""}${esc(it.text)}</p></div>`,
        })),
      };
    case "engagement": {
      const bits = [`${sec.sessionCount} session${sec.sessionCount === 1 ? "" : "s"}`];
      if (sec.firstAt) bits.push(`between ${sec.firstAt} and ${sec.lastAt}`);
      if (sec.cadence) bits.push(sec.cadence);
      const max = Math.max(1, ...(sec.themes || []).map((t) => t.count));
      return {
        intro: P(bits.join(", ") + "."),
        outro: (sec.themes || []).map((t) =>
          `<div class="bar-row"><span class="bar-label">${esc(t.name)}</span><span class="bar"><span class="bar-fill" style="width:${(t.count / max) * 100}%"></span></span><span class="bar-n">${t.count}</span></div>`).join(""),
      };
    }
    case "window-summary":
      return { intro: P(sec.line) };
    // ── pre-session: dense single-line sections ──
    case "understanding":
      return {
        intro: sec.items && sec.items.length ? P(sec.framing, "b-framing") : "",
        items: (sec.items || []).map((it) => ({ id: it.id, html: `<p class="b-line">${esc(it.line)}</p>` })),
      };
    case "happened":
    case "progress":
      return { items: (sec.items || []).map((it) => ({ id: it.id, html: `<p class="b-line">${esc(it.line)}</p>` })) };
    // ── legacy pre-session sections (old saved briefs must still render) ──
    case "sessions": {
      const items = [];
      for (const wk of sec.weeks || []) {
        for (const s of wk.items) items.push({
          id: s.id,
          group: wk.label,
          html: `<div class="b-item"><p><strong>${esc(s.title)}</strong> <span class="b-date">${esc(s.date)}</span>${s.mode === "explore" ? ` <span class="tag">explore</span>` : ""}</p>${s.summary ? `<p class="b-meta">${esc(s.summary)}</p>` : ""}${UL(s.insights)}</div>`,
        });
      }
      return { items };
    }
    case "goals":
      return {
        items: (sec.items || []).map((g) => ({
          id: g.id,
          html: `<div class="b-item"><p><strong>${esc(g.text)}</strong> <span class="tag">${esc(g.statusWord)}</span>${g.isNew ? ` <span class="tag">new this period</span>` : ""}</p>${(g.moves || []).map((m) => `<p class="b-meta">${esc(m.arrow)} ${esc(m.movement)}${m.note ? ` — ${esc(m.note)}` : ""} <span class="b-date">(${esc(m.date)})</span></p>`).join("")}</div>`,
        })),
      };
    case "experiments":
      return {
        items: (sec.items || []).map((e) => ({
          id: e.id,
          html: `<div class="b-item"><p>Instead of “${esc(e.pattern)}” → trying <strong>${esc(e.replacement)}</strong> <span class="tag">${esc(e.status)}</span></p>
            ${(e.checkIns || []).map((c) => `<p class="b-meta">check-in ${esc(c.date)}: ${esc(c.note)} <span class="tag">${esc(c.verdict)}</span></p>`).join("")}
            ${e.outcome ? `<p class="b-meta">Concluded — learned: ${esc(e.outcome.summary)} <span class="tag">${esc(e.outcome.keeping)}</span></p>` : ""}</div>`,
        })),
      };
    case "assignments":
      return {
        items: (sec.items || []).map((a) => ({
          id: a.id,
          html: `<div class="b-item"><p><strong>${esc(a.text)}</strong> <span class="tag">${esc(a.status)}</span></p>${a.whatToNotice ? `<p class="b-meta">Noticing: ${esc(a.whatToNotice)}</p>` : ""}${a.findings ? `<p class="b-meta">Reported: ${esc(a.findings)}</p>` : ""}</div>`,
        })),
      };
    case "events": {
      const items = (sec.occurred || []).map((e) => ({
        id: e.id,
        html: `<div class="b-item"><p><strong>${esc(e.text)}</strong> <span class="b-date">${esc(e.date)} (${esc(e.rel)})</span></p>${e.note ? `<p class="b-meta">${esc(e.note)}</p>` : ""}</div>`,
      }));
      for (const e of sec.horizon || []) items.push({
        id: e.id,
        group: "On the horizon",
        html: `<div class="b-item"><p>${esc(e.text)} <span class="b-date">${e.approx ? "around " : ""}${esc(e.date)} (${esc(e.rel)})</span></p></div>`,
      });
      return { items };
    }
  }
  return {};
}

// ── Data page: the network/lens visualizations (on-screen only) ──

async function renderTherapistData(sub) {
  const SECS = [["network", "Network"], ["lenses", "Lenses"]];
  const sec = SECS.some(([k]) => k === sub) ? sub : "network";
  app.innerHTML = `<h1>Data</h1>
    <p class="sub">An on-screen exploration of the referential memory. This view doesn't go into briefs.</p>
    <div class="journey-pills" id="thpills"></div>
    <div id="ther"></div>`;
  const box = app.querySelector("#ther");
  let data;
  try { data = await api("GET", "/api/memory"); } catch (e) { box.innerHTML = `<p class="muted">Couldn't load: ${esc(e.message)}</p>`; return; }

  const sessions = data.sessions || [];
  const skillsIdx = data.skills || {};

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
  };

  let current = sec;
  const pills = app.querySelector("#thpills");
  const draw = () => {
    pills.innerHTML = SECS.map(([k, label]) =>
      `<span class="mc-chip ${current === k ? "sel" : ""}" data-sec="${k}">${label}</span>`).join("");
    pills.querySelectorAll("[data-sec]").forEach((el) => el.addEventListener("click", () => {
      current = el.dataset.sec;
      history.replaceState(null, "", "#/therapist/data/" + current);
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

