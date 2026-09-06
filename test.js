const fs = require("fs");
const vm = require("vm");

let html = fs.readFileSync("index.html", "utf8");
let code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// strip DOMContentLoaded listener to avoid runtime DOM dependency
code = code.replace(/window\.addEventListener[\s\S]*$/, "");
// expose const declarations to sandbox global
code += "\n;try{this.VETO_CATEGORIES=VETO_CATEGORIES;this.AI_BACKEND_URL=AI_BACKEND_URL;this.RESUME_LIB_URLS=RESUME_LIB_URLS;this.cleanResumeText=cleanResumeText;this.DEFAULT_CATEGORIES=DEFAULT_CATEGORIES;this.HIST_STATUS=HIST_STATUS;this.STATUS_MIGRATE=STATUS_MIGRATE;this.WZ_RED_PRESETS=WZ_RED_PRESETS;this.WZ_DIS_PRESETS=WZ_DIS_PRESETS;this.WZ_INDUSTRY_WORDS=WZ_INDUSTRY_WORDS;}catch(e){}";

// fake DOM + localStorage
const store = {};
const fakeEl = (id) => ({
  _val: "", _text: "", _html: "",
  get value(){return this._val;}, set value(v){this._val=v;},
  get textContent(){return this._text;}, set textContent(v){this._text=v;},
  get innerHTML(){return this._html;}, set innerHTML(v){this._html=v;},
  classList: {add(){},remove(){},toggle(){},contains(){return false;}},
  querySelector: () => ({_val:"", get value(){return this._val;}, set value(v){this._val=v;}}),
  querySelectorAll: () => [],
  style: {},
  scrollIntoView(){},
  focus(){},
  select(){},
  setAttribute(){},
  appendChild(){},
  removeChild(){},
  addEventListener(){},
});
const elems = {};
const sandbox = {
  localStorage: {
    getItem: k => store[k] || null,
    setItem: (k,v) => { store[k] = v; },
    removeItem: k => { delete store[k]; }
  },
  document: {
    getElementById: id => elems[id] || (elems[id] = fakeEl(id)),
    createElement: () => fakeEl("dynamic"),
    querySelector: () => fakeEl("q"),
    body: { appendChild(){}, removeChild(){} }
  },
  window: { addEventListener(){} },
  setTimeout: () => {},
  alert: () => {},
  confirm: () => true,
  navigator: { clipboard: { writeText: async () => {} } },
  JSON, RegExp, Math, parseInt, parseFloat, String, Date,
  console
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

// Make functions accessible
function exportFn(name) {
  return sandbox[name];
}
const loadProfile = exportFn("loadProfile");
const saveProfileObj = exportFn("saveProfileObj");
const buildVetoesFromInput = exportFn("buildVetoesFromInput");
const renderVetoGuides = exportFn("renderVetoGuides");
const VETO_CATEGORIES = exportFn("VETO_CATEGORIES");

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { pass++; console.log("  PASS:", label); }
  else { fail++; console.log("  FAIL:", label); }
}

console.log("=== Test 1: VETO_CATEGORIES structure ===");
assert("5 categories", VETO_CATEGORIES.length === 5);
assert("has boringWork", VETO_CATEGORIES.some(c => c.cat === "boringWork"));
assert("has skillGaps", VETO_CATEGORIES.some(c => c.cat === "skillGaps"));
assert("has majorMismatch", VETO_CATEGORIES.some(c => c.cat === "majorMismatch"));
assert("has direction", VETO_CATEGORIES.some(c => c.cat === "direction"));
assert("has custom", VETO_CATEGORIES.some(c => c.cat === "custom"));
assert("boringWork is warn mode", VETO_CATEGORIES.find(c => c.cat === "boringWork").mode === "warn");
assert("skillGaps is veto mode", VETO_CATEGORIES.find(c => c.cat === "skillGaps").mode === "veto");

console.log("=== Test 2: buildVetoesFromInput reads keywords ===");
// Set up fake input values
sandbox.document.getElementById = id => {
  if (id.startsWith("vetoGuideList_vg_")) {
    const cat = id.replace("vetoGuideList_vg_", "");
    const kwMap = {
      boringWork: "会议纪要, 排版PPT, 翻译报告",
      skillGaps: "Python, 机器学习",
      majorMismatch: "理工科优先",
      direction: "",
      custom: ""
    };
    return { value: kwMap[cat] || "", _val: kwMap[cat] || "" };
  }
  return elems[id] || (elems[id] = fakeEl(id));
};
const vetoes = buildVetoesFromInput("vetoGuideList");
assert("only non-empty categories kept", vetoes.length === 3);
assert("boringWork has keywords", vetoes[0].keywords === "会议纪要, 排版PPT, 翻译报告");
assert("skillGaps has keywords", vetoes[1].keywords === "Python, 机器学习");
assert("majorMismatch has keywords", vetoes[2].keywords === "理工科优先");
assert("direction excluded (empty)", !vetoes.find(v => v.cat === "direction"));

console.log("=== Test 3: veto keyword regex matching ===");
// Simulate the analyze() veto checking logic
const fullJD = "整理会议纪要和排版PPT，需要熟练使用Python和机器学习";
const checkVeto = (veto, text) => {
  const kws = veto.keywords.split(/[，,、;\n]/).map(s => s.trim()).filter(Boolean);
  const pattern = kws.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(pattern, "i");
  return re.test(text);
};
assert("boringWork matches JD", checkVeto(vetoes[0], fullJD));
assert("skillGaps matches JD", checkVeto(vetoes[1], fullJD));
assert("majorMismatch does NOT match JD", !checkVeto(vetoes[2], fullJD));

console.log("=== Test 4: empty keywords skipped ===");
const emptyVetoes = buildVetoesFromInput("vetoGuideList");
// If all empty, returns []
sandbox.document.getElementById = id => {
  if (id.startsWith("vetoGuideList_vg_")) {
    return { value: "", _val: "" };
  }
  return elems[id] || (elems[id] = fakeEl(id));
};
const allEmpty = buildVetoesFromInput("vetoGuideList");
assert("all empty = empty array", allEmpty.length === 0);

console.log("=== Test 5: duration check logic ===");
const maxM = 6;
const durJD1 = "实习期不少于3个月";
const durJD2 = "实习期不少于8个月";
const durJD3 = "至少6个月";
const parseDur = (text) => {
  const m = text.match(/(\d+)\s*个月|不少于\s*(\d+)\s*个月|至少\s*(\d+)\s*个月|(\d+)\s*月以上/i);
  if (m) return parseInt(m[1]||m[2]||m[3]||m[4], 10);
  return null;
};
assert("3 months <= 6, not veto", parseDur(durJD1) <= maxM);
assert("8 months > 6, veto!", parseDur(durJD2) > maxM);
assert("6 months = 6, not veto", parseDur(durJD3) <= maxM);

console.log("=== Test 6: profile save/load with vetoes ===");
const testProfile = {
  name: "TestUser",
  basics: "TestUni · Economics · 5/wk",
  maxMonths: 6,
  assets: [{label:"test", pattern:"test", story:"test"}],
  skillGaps: [],
  vetoes: [
    {cat:"boringWork", label:"不喜欢的工作内容", keywords:"会议纪要,排版", mode:"warn"},
    {cat:"skillGaps", label:"技能短板", keywords:"Python,机器学习", mode:"veto"}
  ],
  intent: "BA"
};
saveProfileObj(testProfile);
const loaded = loadProfile();
assert("loaded profile not null", loaded !== null);
assert("loaded vetoes length 2", loaded.vetoes.length === 2);
assert("loaded veto[0] has keywords", loaded.vetoes[0].keywords === "会议纪要,排版");
assert("loaded maxMonths 6", loaded.maxMonths === 6);

console.log("=== Test 7: privacy check ===");
const code2 = fs.readFileSync("index.html", "utf8");
assert("no 罗景怡", !code2.includes("罗景怡"));
assert("no HCR", !code2.includes("HCR"));
assert("no 中央财经", !code2.includes("中央财经"));

console.log("=== Test 8: export/import round-trip ===");
const buildExportPayload = exportFn("buildExportPayload");
const importProfileText = exportFn("importProfileText");
saveProfileObj({
  name: "ExportUser", basics: "TestUni", maxMonths: 5,
  assets: [{label:"a", pattern:"a", story:"s"}],
  skillGaps: [],
  vetoes: [{cat:"custom", label:"其他", keywords:"外呼", mode:"veto"}],
  intent: "BA", weights: [1,2,1,1,1,1]
});
const payload = buildExportPayload();
assert("payload has app marker", payload.app === "jd-fit-agent");
assert("payload version 0.6", payload.version === "0.6");
const json = JSON.stringify(payload);
sandbox.localStorage.removeItem("jdfit_profile");
importProfileText(json, "importMsg");
const reloaded = loadProfile();
assert("wrapped import restores name", reloaded !== null && reloaded.name === "ExportUser");
assert("wrapped import restores vetoes", reloaded.vetoes.length === 1 && reloaded.vetoes[0].keywords === "外呼");
assert("wrapped import restores weights", Array.isArray(reloaded.weights) && reloaded.weights[1] === 2);
// raw profile (no wrapper) import
importProfileText(JSON.stringify({name:"RawUser", basics:"", maxMonths:3, assets:[], skillGaps:null, vetoes:null}), "importMsg");
const raw = loadProfile();
assert("raw import ok", raw.name === "RawUser" && raw.maxMonths === 3);
assert("raw import normalizes arrays", Array.isArray(raw.vetoes) && Array.isArray(raw.skillGaps));
// invalid JSON / wrong shape rejected, profile unchanged
importProfileText("{broken json", "importMsg");
assert("invalid json rejected", loadProfile().name === "RawUser");
importProfileText(JSON.stringify({name:"NoAssets", nope:1}), "importMsg");
assert("object without assets array rejected", loadProfile().name === "RawUser");

console.log("=== Test 9: weighted total ===");
const getWeights = exportFn("getWeights");
const saveWeights = exportFn("saveWeights");
const computeTotal = exportFn("computeTotal");
saveProfileObj({name:"WUser", basics:"", maxMonths:6, assets:[], skillGaps:[], vetoes:[], weights:[2,0,0,0,0,0]});
assert("getWeights reads custom weights", getWeights()[0] === 2 && getWeights()[1] === 0);
// default weights when missing
saveProfileObj({name:"W2", basics:"", maxMonths:6, assets:[], skillGaps:[], vetoes:[]});
assert("getWeights defaults to equal", getWeights().every(x => x === 1));
// run analyze end-to-end
const setVal = (id, v) => { const el = elems[id] || (elems[id] = fakeEl(id)); el.value = v; };
setVal("jdTitle", "商业分析实习生");
setVal("jdCompany", "");
setVal("jdText", "商业分析实习生。负责策略。");
saveProfileObj({name:"WUser", basics:"", maxMonths:6, assets:[], skillGaps:[], vetoes:[], weights:[2,0,0,0,0,0]});
sandbox.analyze();
assert("d1-only weights -> total 12", Math.abs(computeTotal() - 12) < 1e-9);
saveWeights([1,1,1,1,1,1]);
assert("equal weights -> total 6", Math.abs(computeTotal() - 6) < 1e-9);
assert("weights persisted in profile", loadProfile().weights.join(",") === "1,1,1,1,1,1");

console.log("=== Test 10: resume bank (储备简历) ===");
const loadResumes = exportFn("loadResumes");
const saveResumes = exportFn("saveResumes");
const saveResume = exportFn("saveResume");
const newResumeDraft = exportFn("newResumeDraft");
const loadResumeToEditor = exportFn("loadResumeToEditor");
const deleteResume = exportFn("deleteResume");
const copyResumeText = exportFn("copyResumeText");
sandbox.localStorage.setItem("jdfit_resumes", JSON.stringify([{id:1, name:"通用版", text:"姓名：测试", updatedAt:"2026-08-31 00:00"}]));
assert("loadResumes reads 1 item", loadResumes().length === 1);
saveResumes([{id:2, name:"运营版", text:"x"}, {id:3, name:"BA版", text:"y"}]);
assert("saveResumes persists 2 items", JSON.parse(sandbox.localStorage.getItem("jdfit_resumes")).length === 2);
assert("loadResumes roundtrip", loadResumes().length === 2);
// save via DOM (new draft)
newResumeDraft(); // reset currentResumeId
setVal("resumeName", "测试简历");
setVal("resumeText", "姓名：李四 某大学 用户运营经历");
saveResume();
assert("saveResume adds new item", loadResumes().length === 3);
assert("saveResume stores name", loadResumes().some(r => r.name === "测试简历"));
assert("saved resume has updatedAt", !!loadResumes().find(r => r.name === "测试简历").updatedAt);
// update existing (load then save)
const savedId = loadResumes().find(r => r.name === "测试简历").id;
loadResumeToEditor(savedId);
setVal("resumeText", "updated text");
saveResume();
assert("saveResume updates in place (no new item)", loadResumes().length === 3);
assert("text updated", loadResumes().find(r => r.id === savedId).text === "updated text");
// empty text rejected
newResumeDraft();
setVal("resumeName", "空文本");
setVal("resumeText", "");
const beforeN = loadResumes().length;
saveResume();
assert("empty text rejected (no add)", loadResumes().length === beforeN);
// delete
deleteResume(2);
assert("deleteResume removes item", loadResumes().length === beforeN - 1 && !loadResumes().find(r => r.id === 2));
copyResumeText(); // should not throw
assert("copyResumeText runs without error", true);

console.log("=== Test 11: clear JD inputs (一键清空) ===");
setVal("jdTitle", "某岗位");
setVal("jdCompany", "某公司");
setVal("jdText", "JD正文内容较长……");
sandbox.analyze();
exportFn("clearJDInputs")();
assert("jdTitle cleared", elems["jdTitle"].value === "");
assert("jdCompany cleared", elems["jdCompany"].value === "");
assert("jdText cleared", elems["jdText"].value === "");
assert("result element hidden (classList.add called, no throw)", true);

console.log("=== Test 12: history 状态四态 + 旧数据迁移 + 待投递 ===");
const setHistStatus = exportFn("setHistStatus");
const setHistNote = exportFn("setHistNote");
const escAttr = exportFn("escAttr");
const migrateHistory = exportFn("migrateHistory");
const histScore = exportFn("histScore");
const HIST_STATUS = exportFn("HIST_STATUS");
const STATUS_MIGRATE = exportFn("STATUS_MIGRATE");
// 四态与迁移映射
assert("HIST_STATUS is 4 states", HIST_STATUS.join(",") === "待投递,已投递,不投递,已放弃");
assert("migrate maps 未投递→待投递", STATUS_MIGRATE["未投递"] === "待投递");
assert("migrate maps 面试中→已投递", STATUS_MIGRATE["面试中"] === "已投递");
assert("migrate maps 已结束→已放弃", STATUS_MIGRATE["已结束"] === "已放弃");
assert("migrate maps 不投→不投递", STATUS_MIGRATE["不投"] === "不投递");
assert("migrate maps 已投递→已投递", STATUS_MIGRATE["已投递"] === "已投递");
// 旧五态数据迁移
sandbox.localStorage.setItem("jdfit_history", JSON.stringify([
  {id:1, status:"未投递", total:8},
  {id:2, status:"面试中", total:9},
  {id:3, status:"已结束", total:7},
  {id:4, status:"不投", total:3},
  {id:5, status:"已投递", total:9}
]));
migrateHistory();
const mh = JSON.parse(sandbox.localStorage.getItem("jdfit_history"));
assert("迁移后全部归入四态", mh.every(h=>HIST_STATUS.indexOf(h.status) >= 0));
assert("迁移补全 isInShortlist 布尔", mh.every(h=>typeof h.isInShortlist === "boolean"));
assert("未投递→待投递", mh[0].status === "待投递");
assert("面试中→已投递", mh[1].status === "已投递");
assert("不投→不投递", mh[3].status === "不投递");
// histScore 双制分数归一
assert("histScore uses score field (0-100)", histScore({score: 82}) === 82);
assert("histScore converts total/12 to 0-100", histScore({total: 9}) === 75);
assert("histScore rounds half up", histScore({total: 8.1}) === 68);
// setHistStatus / setHistNote
sandbox.localStorage.setItem("jdfit_history", JSON.stringify([{
  id: 101, date: "2026-09-03 00:00", title: "测试岗", company: "某司",
  total: 8, verdictLabel: "投！优先处理", verdictEmoji: "🟢", verdictCls: "green",
  hasVeto: false, dims: [], vetoResults: [], jdSnippet: "x"
}]));
setHistStatus(101, "已投递");
assert("status saved to storage", JSON.parse(sandbox.localStorage.getItem("jdfit_history"))[0].status === "已投递");
setHistStatus(101, "无效状态值");
assert("invalid status falls back to 待投递", JSON.parse(sandbox.localStorage.getItem("jdfit_history"))[0].status === "待投递");
setHistNote(101, "2026-09-01 已投BOSS直聘");
assert("note saved to storage", JSON.parse(sandbox.localStorage.getItem("jdfit_history"))[0].note === "2026-09-01 已投BOSS直聘");
setHistNote(101, "x".repeat(300));
assert("note capped at 200 chars", JSON.parse(sandbox.localStorage.getItem("jdfit_history"))[0].note.length === 200);
setHistStatus(999, "已投递"); setHistNote(999, "x"); // unknown id, no crash
assert("unknown id no crash", true);
// escAttr escapes quotes for attribute injection safety
assert("escAttr escapes double quotes", escAttr('a"b<c') === 'a&quot;b&lt;c');
assert("escAttr escapes single quotes", escAttr("a'b").indexOf("&#39;") >= 0);
// new analysis -> history item has new-format fields
sandbox.localStorage.setItem("jdfit_history", JSON.stringify([]));
setVal("jdCompany", "");
setVal("jdText", "商业分析实习生\n负责策略与洞察复盘，含数据分析产出。");
sandbox.analyze();
const h3 = JSON.parse(sandbox.localStorage.getItem("jdfit_history"));
assert("new history item has default status 待投递", h3[0].status === "待投递");
assert("new history item has empty note", h3[0].note === "");
assert("new history item has id/timestamp", typeof h3[0].id === "number" && typeof h3[0].timestamp === "number");
assert("new history item position guessed from JD first line", h3[0].position === "商业分析实习生" && "industry" in h3[0] && typeof h3[0].jd === "string");
assert("new history item has 0-100 score", h3[0].score === Math.round(h3[0].total / 12 * 100));
assert("new history item has reasons array (3条)", Array.isArray(h3[0].reasons) && h3[0].reasons.length === 3);
assert("new history item has isInShortlist boolean", typeof h3[0].isInShortlist === "boolean");
assert("score<75 not auto shortlisted", h3[0].score < 75 && h3[0].isInShortlist === false);
// 高分（percent>=75）自动入待投递
saveProfileObj({name:"W3", basics:"", maxMonths:6, assets:[], skillGaps:[], vetoes:[], weights:[2,0,0,0,0,0]});
setVal("jdCompany", "高分司");
setVal("jdText", "商业分析实习生\n负责策略。");
sandbox.analyze();
const h4 = JSON.parse(sandbox.localStorage.getItem("jdfit_history"));
assert("percent>=75 auto shortlisted", h4[0].score === 100 && h4[0].isInShortlist === true);
assert("reasons mention auto shortlist", h4[0].reasons.some(r=>r.includes("待投递")));

console.log("=== Test 13: version + 底部导航4标签结构 ===");
const code3 = fs.readFileSync("index.html", "utf8");
assert("footer shows 职觉 v1.1", code3.includes("职觉 v1.1"));
assert("brand is 职觉", code3.includes("<title>职觉") && code3.includes("</span> 职觉</h1>"));
assert("no JD适配判断器 branding remains", !code3.includes("JD适配判断器"));
assert("landing tab is analyze (画像配置完成即进JD分析页)", code3.includes('showTab("analyze")'));
assert("bottom nav present", code3.includes("id=\"bottomNav\""));
["dash","analyze","shortlist","history"].forEach(k=>{
  assert("pane-"+k+" present", code3.includes("id=\"pane-"+k+"\""));
  assert("nav-"+k+" present", code3.includes("id=\"nav-"+k+"\""));
});
assert("primary blue is #2563EB", code3.includes("#2563EB"));
assert("statGrid present (仪表盘统计卡)", code3.includes("id=\"statGrid\""));
assert("recentBox present (最近检测)", code3.includes("id=\"recentBox\""));
assert("jdIndustry select present", code3.includes("id=\"jdIndustry\""));
assert("slStatusFilter present", code3.includes("id=\"slStatusFilter\""));
assert("slIndustryFilter present", code3.includes("id=\"slIndustryFilter\""));
assert("shortlistBox present", code3.includes("id=\"shortlistBox\""));
assert("histStatusFilter present", code3.includes("id=\"histStatusFilter\""));
assert("histKeyFilter present", code3.includes("id=\"histKeyFilter\""));
assert("resume card present (moved to 仪表盘)", code3.includes("resumeCard"));
const dashChunk = code3.split('id="pane-dash"')[1].split('id="pane-analyze"')[0];
assert("resumeCard now lives in dash pane", dashChunk.includes('id="resumeCard"'));
assert("analyze pane no longer holds resumeCard", !code3.split('id="pane-analyze"')[1].split('id="pane-shortlist"')[0].includes('id="resumeCard"'));
assert("localResult fallback area present", code3.includes('id="localResult"'));
assert("analyzeBtn present (开始分析)", code3.includes('id="analyzeBtn"'));
assert("jdCompany input present", code3.includes('id="jdCompany"'));
assert("jdTitle input removed from analyze page", !code3.includes('id="jdTitle"'));
assert("clear button present", code3.includes("clearJDInputs"));
assert("status select present", code3.includes("setHistStatus"));
assert("note input present", code3.includes("setHistNote"));
assert("showTab function present", code3.includes("function showTab"));
assert("no 罗景怡 (privacy)", !code3.includes("罗景怡"));
assert("no HCR (privacy)", !code3.includes("HCR"));
assert("no 中央财经 (privacy)", !code3.includes("中央财经"));

console.log("=== Test 14: AI 深度分析模块 ===");
const AI_BACKEND_URL = exportFn("AI_BACKEND_URL");
const buildAIReportHTML = exportFn("buildAIReportHTML");
const currentResumeTextForAI = exportFn("currentResumeTextForAI");
assert("AI_BACKEND_URL points to worker", AI_BACKEND_URL === "https://zhijue-backend.luojingyi417.workers.dev");
assert("analyzeJD function exists", typeof exportFn("analyzeJD") === "function");
assert("aiBox rendered in HTML", code3.includes('id="aiBox"'));
assert("optBox rendered in HTML", code3.includes('id="optBox"'));
assert("optBtn rendered in HTML", code3.includes('id="optBtn"'));
assert("AI card has privacy notice", code3.includes("发送到你自己的后端"));
// 四字段协议：analyzeJD 发送 {resume, jd, redLines, dislikes}
assert("analyzeJD is async function", /async function analyzeJD/.test(code3));
assert("analyzeJD posts to /analyze", code3.includes("AI_BACKEND_URL + \"/analyze\""));
assert("analyzeJD body has 4 fields", code3.includes("redLines: profileRedLines(), dislikes: profileDislikes()"));
assert("analyzeJD detects legacy report format", code3.includes("旧版报告格式"));
assert("analyzeJD falls back to local screen", code3.includes("已降级为下方本地快筛"));
assert("optimizeResume is async function", /async function optimizeResume/.test(code3));
assert("optimizeResume posts to /optimize", code3.includes("AI_BACKEND_URL + \"/optimize\""));
// profileRedLines / profileDislikes 从画像 vetoes 派生（veto→redLines, warn→dislikes）
const profileRedLines = exportFn("profileRedLines");
const profileDislikes = exportFn("profileDislikes");
saveProfileObj({name:"R", basics:"", maxMonths:6, assets:[], skillGaps:[], intent:"BA",
  vetoes:[
    {cat:"skillGaps", label:"技能短板", keywords:"Python, 机器学习", mode:"veto"},
    {cat:"boringWork", label:"不喜欢的内容", keywords:"会议纪要、排版", mode:"warn"},
    {cat:"custom", label:"其他", keywords:"外呼", mode:"veto"}
  ]});
assert("profileRedLines collects veto-mode keywords", JSON.stringify(profileRedLines()) === JSON.stringify(["Python","机器学习","外呼"]));
assert("profileDislikes collects warn-mode keywords", JSON.stringify(profileDislikes()) === JSON.stringify(["会议纪要","排版"]));
saveProfileObj({name:"R2", basics:"", maxMonths:6, assets:[], skillGaps:[], vetoes:[]});
assert("profileRedLines empty when no vetoes", profileRedLines().length === 0 && profileDislikes().length === 0);
// currentResumeTextForAI: prefers editor content, falls back to saved resume
setVal("resumeText", "编辑区简历内容");
assert("currentResumeTextForAI prefers editor", currentResumeTextForAI() === "编辑区简历内容");
setVal("resumeText", "");
sandbox.currentResumeId = null;
assert("currentResumeTextForAI empty when nothing saved", currentResumeTextForAI() === "");
// buildAIReportHTML 渲染 v2 格式 {result, score, status, score_details, conflicts, reasons, interview_tips}
const sampleReport = {
  result: "推荐", score: 78, status: "通过初筛",
  score_details: {"技能匹配": 80, "经历相关": 75},
  conflicts: [{level: "高", item: "日常含会议纪要整理", jd_content: "负责会议纪要与纪要归档"}],
  reasons: ["技能匹配度高", "经历相关性好"],
  interview_tips: ["准备SQL案例"]
};
const reportHTML = buildAIReportHTML(sampleReport);
assert("report renders result", reportHTML.includes("推荐"));
assert("report renders score 78", reportHTML.includes("78"));
assert("report renders status chip", reportHTML.includes("通过初筛"));
assert("report renders score_details rows", reportHTML.includes("技能匹配") && reportHTML.includes("80"));
assert("report renders conflicts with JD原文", reportHTML.includes("JD原文") && reportHTML.includes("负责会议纪要与纪要归档"));
assert("report renders reasons", reportHTML.includes("技能匹配度高"));
assert("report renders interview tips", reportHTML.includes("准备SQL案例"));
assert("report has human-judgment disclaimer", reportHTML.includes("AI做执行，人做判断"));
assert("report mentions auto shortlist at >=75", reportHTML.includes("75"));
assert("result emoji: 推荐=🟢", reportHTML.includes("🟢"));
assert("result emoji: 可考虑=🟡", buildAIReportHTML({...sampleReport, result: "可考虑"}).includes("🟡"));
assert("result emoji: 不推荐=🔴", buildAIReportHTML({...sampleReport, result: "不推荐"}).includes("🔴"));
assert("result emoji: unknown=⚪", buildAIReportHTML({...sampleReport, result: "随便写的"}).includes("⚪"));
// XSS safety: report content is escaped
const xssReport = {result: '<img src=x onerror=alert(1)>', status: '<script>x</script>', score_details: {}, conflicts: [{level: "高", item: "<script>bad()</script>"}], reasons: ["<script>bad()</script>"], interview_tips: []};
const xssHTML = buildAIReportHTML(xssReport);
assert("XSS: script content escaped", !xssHTML.includes("<script>bad"));
assert("XSS: img tag not executable", !xssHTML.includes("<img") && xssHTML.includes("&lt;img"));
// edge cases
assert("null report returns empty", buildAIReportHTML(null) === "");
assert("empty arrays render dash", buildAIReportHTML({result: "可考虑", conflicts: [], reasons: [], interview_tips: []}).includes("—"));
// updateHistoryWithAI: AI 结果回写历史 + >=75 自动入库
const updateHistoryWithAI = exportFn("updateHistoryWithAI");
sandbox.localStorage.setItem("jdfit_history", JSON.stringify([{
  id: 501, date: "2026-09-03 00:00", title: "AI岗", company: "AI司", position: "AI岗",
  total: 8, score: 67, status: "待投递", note: "", isInShortlist: false,
  reasons: [], interview_tips: [], conflicts: [], resume_advice: null,
  dims: [], vetoResults: [], jdSnippet: "jd文本"
}]));
vm.runInContext("lastAnalysis = {raw:'jd文本', histId:501, title:'AI岗', company:'AI司', industry:'互联网', hasVeto:false, dims:[{name:'d1',score:2,note:''},{name:'d2',score:2,note:'',hits:[]}], vetoResults:[]};", sandbox);
updateHistoryWithAI(sampleReport);
let hAI = JSON.parse(sandbox.localStorage.getItem("jdfit_history"))[0];
assert("AI score 回写历史", hAI.score === 78);
assert("AI result 回写历史", hAI.result === "推荐");
assert("AI reasons 回写历史", hAI.reasons.length === 2);
assert("AI interview_tips 回写历史", hAI.interview_tips.length === 1);
assert("AI conflicts 回写历史", hAI.conflicts.length === 1);
assert("AI score>=75 自动入待投递", hAI.isInShortlist === true);
// score<75 不自动入库
sandbox.localStorage.setItem("jdfit_history", JSON.stringify([{id:502, title:"B岗", score:60, status:"待投递", isInShortlist:false, reasons:[], interview_tips:[], conflicts:[]}]));
vm.runInContext("lastAnalysis.histId = 502;", sandbox);
updateHistoryWithAI({...sampleReport, score: 60});
assert("AI score<75 不自动入库", JSON.parse(sandbox.localStorage.getItem("jdfit_history"))[0].isInShortlist === false);
// 不推荐 不自动入库
sandbox.localStorage.setItem("jdfit_history", JSON.stringify([{id:503, title:"C岗", score:60, status:"待投递", isInShortlist:false, reasons:[], interview_tips:[], conflicts:[]}]));
vm.runInContext("lastAnalysis.histId = 503;", sandbox);
updateHistoryWithAI({...sampleReport, score: 88, result: "不推荐"});
assert("不推荐 不自动入库", JSON.parse(sandbox.localStorage.getItem("jdfit_history"))[0].isInShortlist === false);
// 无 lastAnalysis.histId 时安全返回
vm.runInContext("lastAnalysis = null;", sandbox);
updateHistoryWithAI(sampleReport);
assert("updateHistoryWithAI null-safe", true);
vm.runInContext("lastAnalysis = {histId: 999999};", sandbox);
updateHistoryWithAI(sampleReport);
assert("updateHistoryWithAI unknown histId no crash", true);
// buildOptimizeHTML: 简历优化建议渲染
const buildOptimizeHTML = exportFn("buildOptimizeHTML");
const optHTML = buildOptimizeHTML(["补充用户分层关键词", "量化转化率数据"]);
assert("optimize renders suggestions", optHTML.includes("补充用户分层关键词") && optHTML.includes("量化转化率数据"));
assert("optimize has honesty disclaimer", optHTML.includes("不虚构"));
assert("optimize empty list shows message", buildOptimizeHTML([]).includes("未返回优化建议"));
assert("optimize null list shows message", buildOptimizeHTML(null).includes("未返回优化建议"));
assert("optimize XSS escaped", !buildOptimizeHTML(["<script>bad()</script>"]).includes("<script>bad"));

console.log("=== Test 15: 简历文件上传（PDF/Word/TXT本地解析）===");
// HTML 结构：上传按钮、file input、检查提示条
assert("upload file input present", code3.includes('id="resumeFile"'));
assert("file input accepts pdf/docx/txt", code3.includes('accept=".pdf,.docx,.txt"'));
assert("upload check banner present", code3.includes('id="uploadCheckBanner"'));
assert("banner shows char count element", code3.includes('id="uploadCharCount"'));
assert("banner shows source element", code3.includes('id="uploadSource"'));
assert("upload button triggers file picker", code3.includes("getElementById('resumeFile').click()"));
assert("handleResumeFile wired to onchange", code3.includes("onchange=\"handleResumeFile(this)\""));
assert("confirm button exists", code3.includes("confirmResumeUpload()"));
// 处理函数存在
assert("handleResumeFile is function", typeof exportFn("handleResumeFile") === "function");
assert("confirmResumeUpload is function", typeof exportFn("confirmResumeUpload") === "function");
assert("extractPdfText is function", typeof exportFn("extractPdfText") === "function");
assert("extractDocxText is function", typeof exportFn("extractDocxText") === "function");
assert("loadResumeLib is function", typeof exportFn("loadResumeLib") === "function");
// 解析库 CDN 地址（多源兜底）
const LIBS = exportFn("RESUME_LIB_URLS");
assert("RESUME_LIB_URLS has pdfjs sources", Array.isArray(LIBS.pdfjs) && LIBS.pdfjs.length >= 2);
assert("RESUME_LIB_URLS has mammoth sources", Array.isArray(LIBS.mammoth) && LIBS.mammoth.length >= 2);
assert("pdfjs from trusted CDN", LIBS.pdfjs.every(u => u.startsWith("https://")));
assert("mammoth from trusted CDN", LIBS.mammoth.every(u => u.startsWith("https://")));
// cleanResumeText 纯函数：换行/空格/全角空格清理
const cleanResumeText = exportFn("cleanResumeText");
assert("cleanResumeText collapses CRLF", cleanResumeText("a\r\nb\rc") === "a\nb\nc");
assert("cleanResumeText trims spaces before newline", cleanResumeText("a  \nb") === "a\nb");
assert("cleanResumeText collapses 3+ newlines", cleanResumeText("a\n\n\n\nb") === "a\n\nb");
assert("cleanResumeText replaces nbsp", cleanResumeText("a\u00a0\u00a0b") === "a b");
assert("cleanResumeText collapses double spaces", cleanResumeText("a    b") === "a b");
assert("cleanResumeText trims ends", cleanResumeText("  hello  ") === "hello");
assert("cleanResumeText null-safe", cleanResumeText(null) === "" && cleanResumeText(undefined) === "");
// 覆盖确认与太少文字防护逻辑存在于源码
assert("overwrite confirm guard present", code3.includes("上传将覆盖当前的简历内容"));
assert("too-short text guard present", code3.includes("识别出的文字太少"));
assert("doc old-format rejection message present", code3.includes(".doc 老格式浏览器无法解析"));
assert("upload stays local (privacy wording)", code3.includes("本地解析，文件不上传"));
// 隐私：CDN 域名白名单不含私有地址
assert("no localhost in lib urls", !JSON.stringify(LIBS).includes("localhost"));
assert("no 127.0.0.1 in lib urls", !JSON.stringify(LIBS).includes("127.0.0.1"));

console.log("=== Test 16: 分析页简化（职觉规格） ===");
assert("jdResumeSel selector removed", !code3.includes('id="jdResumeSel"'));
assert("pickResumeForCompare removed", !code3.includes("function pickResumeForCompare"));
assert("renderJDResumeSel removed", !code3.includes("function renderJDResumeSel"));
assert("renderPasteFromBank no longer refreshes jd selector", !code3.includes("renderJDResumeSel();"));
assert("demo buttons removed from analyze page", !code3.includes("loadDemo('kimi')"));
// guessJDTitle：从JD首行猜岗位名（≤30字）
const guessJDTitle = exportFn("guessJDTitle");
assert("guessJDTitle takes first line", guessJDTitle("商业分析实习生\n岗位职责：负责策略复盘。") === "商业分析实习生");
assert("guessJDTitle empty for long first line", guessJDTitle("这是一个特别长的首行超过三十个字符的职位描述标题行内容超长了呀") === "");
assert("guessJDTitle empty for empty text", guessJDTitle("") === "");
assert("guessJDTitle skips blank lines", guessJDTitle("\n\n  \n增长运营实习生\n负责增长策略。") === "增长运营实习生");

console.log("=== Test 17: 画像配置向导（Step 1-4，原版职觉规格） ===");
// 结构：4 步向导替代旧 tabs/单页表单
assert("old paste/import tabs removed", !code3.includes('id="tabPaste"') && !code3.includes('id="panePaste"'));
assert("old buildProfile removed", !code3.includes("function buildProfile"));
assert("old switchTab removed", !code3.includes("function switchTab"));
assert("old fillPasteFromBank removed", !code3.includes("function fillPasteFromBank"));
assert("old vetoGuideList removed from onboarding", !code3.includes('id="vetoGuideList"'));
assert("onboarding card present", code3.includes('id="onboarding"'));
// Step 1 引导页
assert("Step1 present", code3.includes('id="wz1"'));
assert("brand title 职觉 · 职业画像", code3.includes("职觉 · 职业画像"));
assert("Step1 subtitle present", code3.includes("3 步建立你的职业偏好画像，之后每次 JD 分析都基于你的个人设定"));
assert("开始创建 button", code3.includes(">开始创建<"));
// Step 2 导入简历
assert("Step2 present", code3.includes('id="wz2"'));
assert("Step2 title", code3.includes("导入你的简历"));
assert("drop zone present", code3.includes('id="wzDrop"'));
assert("drop zone supports drag", code3.includes("ondragover") && code3.includes("ondrop"));
assert("wzFile accepts docx/pdf/txt", code3.includes('id="wzFile" accept=".docx,.pdf,.txt"'));
assert("wzFile wired to wzResume", code3.includes("handleResumeFile(this,'wzResume',null,'wzUploadMsg')"));
assert("drop handler present", code3.includes("wzHandleDrop(event)"));
assert("Step2 next button", code3.includes("wzNext2()"));
// Step 3 红线关键词
assert("Step3 present", code3.includes('id="wz3"'));
assert("Step3 title", code3.includes("设置红线关键词"));
assert("Step3 subtitle marks 不推荐", code3.includes("自动标记为「不推荐」"));
assert("red presets container", code3.includes('id="wzRedPresets"'));
assert("red selected container", code3.includes('id="wzRedSel"'));
assert("red add input present", code3.includes('id="wzRedInput"'));
// Step 4 不喜欢的工作内容
assert("Step4 present", code3.includes('id="wz4"'));
assert("Step4 title", code3.includes("设置你不喜欢的工作内容"));
assert("dis presets container", code3.includes('id="wzDisPresets"'));
assert("dis selected container", code3.includes('id="wzDisSel"'));
assert("完成创建画像 button", code3.includes("wzFinish()"));
// 进度条 + 卡片样式
assert("progress bar present", code3.includes('id="wzBar"'));
assert("step counter present", code3.includes('id="wzStepNum"'));
assert("wizard card max-width 800px", code3.includes("max-width:800px"));
assert("progress bar transition", code3.includes("transition:width"));
assert("step fade animation", code3.includes("@keyframes wzfade"));
// 预设标签内容
const WZ_RED_PRESETS = exportFn("WZ_RED_PRESETS");
const WZ_DIS_PRESETS = exportFn("WZ_DIS_PRESETS");
assert("25 red presets", WZ_RED_PRESETS.length === 25);
assert("key red presets present", ["理工科优先","硕士及以上学历","Python/SQL/Excel","接受加班","自主学习能力","有公众号/小红书/知乎等平台运营经验"].every(t=>WZ_RED_PRESETS.includes(t)));
assert("industry words removed from red presets", ["互联网","金融","咨询","医药"].every(t=>!WZ_RED_PRESETS.includes(t)));
assert("industry words constant defined", exportFn("WZ_INDUSTRY_WORDS").length === 4);
assert("11 dislike presets", WZ_DIS_PRESETS.length === 11);
assert("key dislike presets present", ["频繁出差","外包岗位","大小周","团建","群消息@所有人"].every(t=>WZ_DIS_PRESETS.includes(t)));
// 行为：步骤切换 + 进度条
const wzGo = exportFn("wzGo");
wzGo(3);
assert("wzGo sets progress 75%", elems["wzBar"].style.width === "75%");
assert("wzGo sets step counter", elems["wzStepNum"].textContent === "步骤 3 / 4");
wzGo(4);
assert("wzGo sets progress 100%", elems["wzBar"].style.width === "100%");
// 行为：预设标签切换
const wzTogglePreset = exportFn("wzTogglePreset");
wzTogglePreset("red", "接受加班");
assert("preset toggled on renders selected chip", elems["wzRedSel"]._html.includes("接受加班"));
assert("preset chip gets on class", elems["wzRedPresets"]._html.includes("wz-tag on"));
wzTogglePreset("red", "接受加班");
assert("preset toggled off removes chip", !elems["wzRedSel"]._html.includes("接受加班"));
// 行为：手动添加（逗号/顿号分隔 + 去重）
const wzAddRed = exportFn("wzAddRed");
const wzAddDis = exportFn("wzAddDis");
const wzRemoveTag = exportFn("wzRemoveTag");
setVal("wzRedInput", "驻场开发, 需自带电脑");
wzAddRed();
assert("wzAddRed parses comma-separated", elems["wzRedSel"]._html.includes("驻场开发") && elems["wzRedSel"]._html.includes("需自带电脑"));
assert("wzAddRed clears input", elems["wzRedInput"].value === "");
setVal("wzRedInput", "驻场开发");
wzAddRed();
assert("wzAddRed dedupes", (elems["wzRedSel"]._html.match(/驻场开发/g)||[]).length === 1);

console.log("=== Test 17b: 启动清理行业词红线（0分否决bug修复） ===");
// 用脏数据重建沙箱：画像 vetoes 与向导 redLines 均含行业词
const dirtyStore = {};
dirtyStore["jdfit_profile"] = JSON.stringify({
  name: "TestUser", basics: "x", maxMonths: 6, assets: [], skillGaps: [],
  vetoes: [
    {cat:"custom", label:"红线关键词", keywords:"互联网, 外包岗位, 金融", mode:"veto"},
    {cat:"boringWork", label:"不喜欢的工作内容", keywords:"互联网, 团建", mode:"warn"}
  ], intent: ""
});
dirtyStore["zhijue_profile"] = JSON.stringify({
  profileCompleted: true,
  profile: {resume: "简历内容足够长足够长足够长", redLines: ["互联网","咨询","频繁出差"], dislikes: ["团建"]}
});
const dirtySandbox = {
  localStorage: {
    getItem: k => (k in dirtyStore) ? dirtyStore[k] : null,
    setItem: (k,v) => { dirtyStore[k] = v; },
    removeItem: k => { delete dirtyStore[k]; }
  },
  document: {
    getElementById: () => fakeEl("any"),
    createElement: () => fakeEl("dynamic"),
    querySelector: () => fakeEl("q"),
    body: { appendChild(){}, removeChild(){} }
  },
  window: { addEventListener(){} },
  setTimeout: () => {}, alert: () => {}, confirm: () => true,
  navigator: { clipboard: { writeText: async () => {} } },
  JSON, RegExp, Math, parseInt, parseFloat, String, Date, console
};
vm.createContext(dirtySandbox);
vm.runInContext(code, dirtySandbox);
const cleanWiz = JSON.parse(dirtyStore["zhijue_profile"]);
assert("wizard redLines industry words removed", !cleanWiz.profile.redLines.includes("互联网") && !cleanWiz.profile.redLines.includes("咨询"));
assert("wizard redLines keeps valid words", cleanWiz.profile.redLines.includes("频繁出差"));
assert("wizard dislikes untouched", cleanWiz.profile.dislikes.includes("团建"));
const cleanProf = JSON.parse(dirtyStore["jdfit_profile"]);
const vetoEntry = cleanProf.vetoes.find(v => v.mode === "veto");
assert("profile veto keywords industry words removed", !vetoEntry.keywords.includes("互联网") && !vetoEntry.keywords.includes("金融"));
assert("profile veto keeps 外包岗位", vetoEntry.keywords.includes("外包岗位"));
const warnEntry = cleanProf.vetoes.find(v => v.mode === "warn");
assert("warn-level keywords untouched (行业词仅清否决级)", warnEntry.keywords.includes("互联网"));
wzRemoveTag("red", 0);
assert("wzRemoveTag removes by index", !elems["wzRedSel"]._html.includes("驻场开发"));
setVal("wzDisInput", "长期驻场");
wzAddDis();
assert("wzAddDis adds content", elems["wzDisSel"]._html.includes("长期驻场"));
// 行为：Step2 校验（空简历不放行，进度不变）
const wzNext2 = exportFn("wzNext2");
setVal("wzResume", "");
wzNext2();
assert("wzNext2 blocks empty resume", elems["wzBar"].style.width === "100%");
assert("wzNext2 shows warning", elems["wzUploadMsg"]._text.includes("请先上传"));
setVal("wzResume", "姓名：测试 五道口职业技术学院 用户运营经历 数据分析 竞品分析 从0到1 方法论沉淀 用户分层 触达转化");
wzNext2();
assert("wzNext2 passes with resume (75%)", elems["wzBar"].style.width === "75%");
// 行为：wzFinish 全链路（规格存储 + 引擎画像 + 简历入储备区）
sandbox.localStorage.removeItem("zhijue_profile");
sandbox.localStorage.removeItem("jdfit_profile");
const wzFinish = exportFn("wzFinish");
wzFinish();
const savedCfg = JSON.parse(sandbox.localStorage.getItem("zhijue_profile"));
assert("wzFinish saves spec storage (profileCompleted)", savedCfg.profileCompleted === true);
assert("spec storage has resume", savedCfg.profile.resume.includes("用户运营"));
assert("spec storage redLines", JSON.stringify(savedCfg.profile.redLines) === JSON.stringify(["需自带电脑"]));
assert("spec storage dislikes", JSON.stringify(savedCfg.profile.dislikes) === JSON.stringify(["长期驻场"]));
assert("engine profile created", loadProfile() !== null);
assert("engine vetoes custom veto mode", loadProfile().vetoes.some(v=>v.cat==="custom" && v.mode==="veto" && v.keywords.includes("需自带电脑")));
assert("engine vetoes boringWork warn mode", loadProfile().vetoes.some(v=>v.cat==="boringWork" && v.mode==="warn" && v.keywords.includes("长期驻场")));
assert("resume synced to bank as 画像简历", loadResumes().some(r=>r.name==="画像简历" && r.text.includes("用户运营")));
assert("wizard resume feeds AI analysis", exportFn("currentResumeTextForAI")().includes("用户运营"));
assert("assets extracted from resume", loadProfile().assets.length > 0);
// 行为：wzFinish 空简历守卫（跳回 Step 2）
setVal("wzResume", "");
wzFinish();
assert("wzFinish empty resume returns to step 2", elems["wzStepNum"].textContent === "步骤 2 / 4");
// 行为：backToOnboarding 回填（从规格存储）
const backToOnboarding = exportFn("backToOnboarding");
setVal("wzResume", "占位");
backToOnboarding();
assert("backToOnboarding prefills resume from config", elems["wzResume"].value.includes("用户运营"));
assert("backToOnboarding restores red chips", elems["wzRedSel"]._html.includes("需自带电脑"));
assert("backToOnboarding restores dis chips", elems["wzDisSel"]._html.includes("长期驻场"));
assert("backToOnboarding resets to step 1", elems["wzStepNum"].textContent === "步骤 1 / 4");
// 行为：旧画像兼容（无 zhijue_profile 时从 vetoes 派生）
sandbox.localStorage.removeItem("zhijue_profile");
saveProfileObj({name:"L", basics:"", maxMonths:6, assets:[], skillGaps:[], vetoes:[
  {cat:"custom", label:"红线关键词", keywords:"纯电销", mode:"veto"},
  {cat:"boringWork", label:"不喜欢", keywords:"团建", mode:"warn"}
]});
backToOnboarding();
assert("legacy profile derives redLines", elems["wzRedSel"]._html.includes("纯电销"));
assert("legacy profile derives dislikes", elems["wzDisSel"]._html.includes("团建"));
// 行为：clearAll 双键清理
const clearAll = exportFn("clearAll");
sandbox.localStorage.setItem("zhijue_profile", JSON.stringify({profile:{resume:"x",redLines:[],dislikes:[]},profileCompleted:true}));
clearAll();
assert("clearAll removes zhijue_profile", sandbox.localStorage.getItem("zhijue_profile") === null);
assert("clearAll removes jdfit_profile", sandbox.localStorage.getItem("jdfit_profile") === null);
assert("clearAll resets to step 1", elems["wzStepNum"].textContent === "步骤 1 / 4");
// 文件上传泛化保留
assert("handleResumeFileObj is function", typeof exportFn("handleResumeFileObj") === "function");
assert("handleResumeFile keeps signature", code3.includes("async function handleResumeFile(input, targetId, nameId, msgId)"));

console.log("=== Test 18: 行业分类 + 待投递列表 + 仪表盘 ===");
// 行业分类：8个默认 + localStorage 覆盖
const DEFAULT_CATEGORIES = exportFn("DEFAULT_CATEGORIES");
const loadCategories = exportFn("loadCategories");
const saveCategories = exportFn("saveCategories");
assert("8 default categories", DEFAULT_CATEGORIES.length === 8);
assert("default categories content", ["互联网","金融","咨询","医药","快消","国企","外企","创业公司"].every(c=>DEFAULT_CATEGORIES.indexOf(c) >= 0));
assert("loadCategories defaults when storage empty", loadCategories().length === 8);
saveCategories(["互联网","游戏"]);
assert("saveCategories persists override", JSON.stringify(loadCategories()) === JSON.stringify(["互联网","游戏"]));
sandbox.localStorage.removeItem("jdfit_categories");
assert("loadCategories falls back after removal", loadCategories().length === 8);
// 待投递列表
const shortlistItems = exportFn("shortlistItems");
const renderShortlist = exportFn("renderShortlist");
const renderDashboard = exportFn("renderDashboard");
const toggleShortlist = exportFn("toggleShortlist");
const populateSlIndustries = exportFn("populateSlIndustries");
const showTab = exportFn("showTab");
sandbox.localStorage.setItem("jdfit_history", JSON.stringify([
  {id:1, company:"甲司", position:"运营实习", industry:"互联网", score:80, status:"待投递", note:"优先投", isInShortlist:true, date:"2026-09-01"},
  {id:2, company:"乙司", position:"行研实习", industry:"金融", score:85, status:"已投递", note:"", isInShortlist:true, date:"2026-09-02"},
  {id:3, company:"丙司", position:"分析实习", industry:"互联网", score:60, status:"不投递", note:"", isInShortlist:false, date:"2026-09-03"}
]));
assert("shortlistItems filters isInShortlist", shortlistItems().length === 2);
// 行业筛选下拉：列出已用行业
populateSlIndustries();
const indEl = sandbox.document.getElementById("slIndustryFilter");
assert("industry filter lists used industries", indEl._html.includes("互联网") && indEl._html.includes("金融"));
assert("industry filter has 全部行业 option", indEl._html.includes("全部行业"));
// 表格渲染
renderShortlist();
const slBox = sandbox.document.getElementById("shortlistBox");
assert("shortlist table has 7 columns", ["公司","岗位","行业","分数","状态","备注","操作"].every(t=>slBox._html.includes(t)));
assert("shortlist shows only shortlisted items", slBox._html.includes("甲司") && slBox._html.includes("乙司") && !slBox._html.includes("丙司"));
assert("shortlist renders score", slBox._html.includes(">80<"));
assert("shortlist renders note value", slBox._html.includes("优先投"));
assert("shortlist pin button wired", slBox._html.includes("toggleShortlist(1)"));
assert("shortlist status select wired", slBox._html.includes("setHistStatus(1"));
// 状态筛选
setVal("slStatusFilter", "已投递");
renderShortlist();
assert("status filter works", slBox._html.includes("乙司") && !slBox._html.includes("甲司"));
setVal("slStatusFilter", "");
setVal("slIndustryFilter", "互联网");
renderShortlist();
assert("industry filter works", slBox._html.includes("甲司") && !slBox._html.includes("乙司"));
setVal("slIndustryFilter", "");
setVal("slStatusFilter", "已放弃");
renderShortlist();
assert("filter with no match shows empty hint", slBox._html.includes("暂无待投递岗位"));
setVal("slStatusFilter", "");
// 空待投递提示
sandbox.localStorage.setItem("jdfit_history", JSON.stringify([{id:9, company:"丁司", position:"x", score:50, status:"待投递", isInShortlist:false}]));
renderShortlist();
assert("empty shortlist shows hint with 75 rule", slBox._html.includes("75"));
// toggleShortlist 手动加入/移出
sandbox.localStorage.setItem("jdfit_history", JSON.stringify([
  {id:1, company:"甲司", position:"运营实习", industry:"互联网", score:80, status:"待投递", note:"", isInShortlist:true},
  {id:3, company:"丙司", position:"分析实习", industry:"互联网", score:60, status:"不投递", note:"", isInShortlist:false}
]));
toggleShortlist(3);
assert("toggle adds to shortlist", shortlistItems().length === 2);
toggleShortlist(1);
assert("toggle removes from shortlist", shortlistItems().length === 1 && shortlistItems()[0].id === 3);
toggleShortlist(999); // unknown id no crash
assert("toggleShortlist unknown id no crash", true);
// 仪表盘统计
sandbox.localStorage.setItem("jdfit_history", JSON.stringify([
  {id:1, company:"甲司", position:"运营实习", industry:"互联网", score:80, status:"待投递", note:"", isInShortlist:true, date:"2026-09-01"},
  {id:2, company:"乙司", position:"行研实习", industry:"金融", score:85, status:"已投递", note:"", isInShortlist:true, date:"2026-09-02"},
  {id:3, company:"丙司", position:"分析实习", industry:"互联网", total:9, status:"不投递", note:"", isInShortlist:false, date:"2026-09-03"},
  {id:4, company:"丁司", position:"产品实习", industry:"国企", score:0, status:"已放弃", note:"", isInShortlist:false, date:"2026-09-04", hasVeto:true}
]));
renderDashboard();
const statGrid = sandbox.document.getElementById("statGrid");
assert("dashboard stats: 累计检测=4", statGrid._html.includes("累计检测") && statGrid._html.includes(">4<"));
assert("dashboard stats: 待投递池=2", statGrid._html.includes("待投递池") && statGrid._html.includes(">2<"));
assert("dashboard stats: 已投递=1", statGrid._html.includes("已投递") && statGrid._html.includes(">1<"));
// 平均分：(80+85+75+0)/4 = 60
assert("dashboard stats: 平均匹配分=60 (histScore 归一混合制)", statGrid._html.includes("平均匹配分") && statGrid._html.includes(">60<"));
const recentBox = sandbox.document.getElementById("recentBox");
assert("recent shows top-3 items (not the 4th)", recentBox._html.includes("甲司") && !recentBox._html.includes("丁司"));
assert("recent item is clickable (viewHistory)", recentBox._html.includes("viewHistory(1)"));
// showTab 切换不抛错
showTab("analyze");
showTab("dash");
assert("showTab runs without error", true);

console.log("=== Test 19: analyzeJD 开始分析全链路（后端调用 + 降级） ===");
(async () => {
  // 准备：画像（含红线）+ 简历 + JD
  saveProfileObj({name:"AJ", basics:"", maxMonths:6, assets:[], skillGaps:[],
    vetoes:[{cat:"custom", label:"红线", keywords:"外包", mode:"veto"},
            {cat:"boringWork", label:"不喜欢", keywords:"会议纪要", mode:"warn"}]});
  setVal("resumeText", "测试简历内容");
  const aiBox = sandbox.document.getElementById("aiBox");
  const verdictBox = sandbox.document.getElementById("verdictBox");
  // --- 成功路径 ---
  sandbox.localStorage.setItem("jdfit_history", JSON.stringify([]));
  setVal("jdCompany", "测试司");
  setVal("jdIndustry", "互联网");
  setVal("jdText", "商业分析实习生\n负责用户运营策略与数据复盘，JD内容足够长超过二十个字的要求已满足。");
  let captured = null;
  sandbox.fetch = async (url, opts) => {
    captured = {url: url, body: JSON.parse(opts.body)};
    return {ok: true, json: async () => ({ok: true, engine: "llm", report: {result: "推荐", score: 82, status: "匹配", score_details: {}, conflicts: [], reasons: ["理由A"], interview_tips: ["建议B"]}})};
  };
  await sandbox.analyzeJD();
  assert("analyzeJD posts to /analyze", captured && captured.url.endsWith("/analyze"));
  assert("analyzeJD sends 4-field body", captured && captured.body.resume === "测试简历内容" && JSON.stringify(captured.body.redLines) === JSON.stringify(["外包"]) && JSON.stringify(captured.body.dislikes) === JSON.stringify(["会议纪要"]));
  let hist = JSON.parse(sandbox.localStorage.getItem("jdfit_history"));
  assert("analyzeJD creates history record", hist.length === 1);
  assert("analyzeJD stores company/industry", hist[0].company === "测试司" && hist[0].industry === "互联网");
  assert("analyzeJD writes AI score/result into history", hist[0].score === 82 && hist[0].result === "推荐");
  assert("analyzeJD auto shortlists at score 82", hist[0].isInShortlist === true);
  assert("analyzeJD renders AI report", aiBox._html.includes("推荐") && aiBox._html.includes("82"));
  assert("local quick screen ran (verdict rendered)", verdictBox._html.length > 0);
  // --- 降级路径：fetch 抛错 ---
  sandbox.fetch = async () => { throw new Error("network down"); };
  sandbox.localStorage.setItem("jdfit_history", JSON.stringify([]));
  setVal("jdText", "增长运营实习生\n负责用户增长与投放策略复盘，JD内容足够长超过二十个字的要求已满足。");
  await sandbox.analyzeJD();
  assert("fallback shows degradation message", aiBox._html.includes("降级") && aiBox._html.includes("network down"));
  hist = JSON.parse(sandbox.localStorage.getItem("jdfit_history"));
  assert("fallback still saves local history record", hist.length === 1 && typeof hist[0].total === "number" && hist[0].score >= 0);
  // --- 输入校验：JD太短 ---
  setVal("jdText", "太短");
  await sandbox.analyzeJD();
  assert("short JD rejected (no new record)", JSON.parse(sandbox.localStorage.getItem("jdfit_history")).length === 1);
  // --- 无简历时提示（currentResumeId 是 vm 内部 let，无法外部覆盖；清空简历库使其查不到） ---
  setVal("resumeText", "");
  sandbox.localStorage.setItem("jdfit_resumes", "[]");
  sandbox.fetch = async () => ({ok: true, json: async () => ({ok: true, report: {result: "推荐"}})});
  setVal("jdText", "商业分析实习生\n负责策略复盘与洞察产出，JD内容足够长超过二十个字的要求已满足。");
  await sandbox.analyzeJD();
  assert("missing resume rejected (no new record)", JSON.parse(sandbox.localStorage.getItem("jdfit_history")).length === 1);
  setVal("resumeText", "测试简历内容");
  // --- 旧格式报告检测 ---
  sandbox.fetch = async () => ({ok: true, json: async () => ({ok: true, report: {verdict: "旧版字段"}})});
  await sandbox.analyzeJD();
  assert("legacy report format triggers fallback wording", aiBox._html.includes("旧版报告格式"));
  // --- 红线命中（后端规则引擎路径）---
  sandbox.fetch = async () => ({ok: true, json: async () => ({ok: true, engine: "rule", report: {result: "不推荐", score: 30, reasons: ["命中红线：外包"], conflicts: [], interview_tips: []}})});
  sandbox.localStorage.setItem("jdfit_history", JSON.stringify([]));
  setVal("jdText", "运营实习生（外包岗位）\n负责内容整理与社群维护，JD内容足够长超过二十个字的要求已满足。");
  await sandbox.analyzeJD();
  hist = JSON.parse(sandbox.localStorage.getItem("jdfit_history"));
  assert("rule-engine rejection stored with 不推荐", hist[0].result === "不推荐");
  assert("不推荐 not shortlisted even at high local score", hist[0].isInShortlist === false);
  assert("rule engine note rendered", aiBox._html.includes("规则引擎"));

  console.log("\n=== Results: " + pass + " passed, " + fail + " failed ===");
  if (fail > 0) process.exit(1);
})().catch(e => { console.error("TEST RUNNER ERROR:", e); process.exit(1); });
