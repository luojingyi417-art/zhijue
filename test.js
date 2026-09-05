const fs = require("fs");
const vm = require("vm");

let html = fs.readFileSync("index.html", "utf8");
let code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// strip DOMContentLoaded listener to avoid runtime DOM dependency
code = code.replace(/window\.addEventListener[\s\S]*$/, "");
// expose const declarations to sandbox global
code += "\n;try{this.VETO_CATEGORIES=VETO_CATEGORIES;this.AI_BACKEND_URL=AI_BACKEND_URL;this.RESUME_LIB_URLS=RESUME_LIB_URLS;this.cleanResumeText=cleanResumeText;}catch(e){}";

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
const fillPasteFromBank = exportFn("fillPasteFromBank");
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
// fill onboarding paste tab from bank
fillPasteFromBank(String(savedId));
assert("fillPasteFromBank fills p_resume", elems["p_resume"].value === "updated text");
fillPasteFromBank("");
assert("fillPasteFromBank ignores empty", elems["p_resume"].value === "updated text");
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

console.log("=== Test 12: history 投递状态 + 备注 ===");
const setHistStatus = exportFn("setHistStatus");
const setHistNote = exportFn("setHistNote");
const escAttr = exportFn("escAttr");
sandbox.localStorage.setItem("jdfit_history", JSON.stringify([{
  id: 101, date: "2026-08-31 00:00", title: "测试岗", company: "某司",
  total: 8, verdictLabel: "投！优先处理", verdictEmoji: "🟢", verdictCls: "green",
  hasVeto: false, dims: [], vetoResults: [], jdSnippet: "x"
}]));
setHistStatus(101, "已投递");
assert("status saved to storage", JSON.parse(sandbox.localStorage.getItem("jdfit_history"))[0].status === "已投递");
setHistStatus(101, "无效状态值");
assert("invalid status falls back to 未投递", JSON.parse(sandbox.localStorage.getItem("jdfit_history"))[0].status === "未投递");
setHistNote(101, "2026-09-01 已投BOSS直聘");
assert("note saved to storage", JSON.parse(sandbox.localStorage.getItem("jdfit_history"))[0].note === "2026-09-01 已投BOSS直聘");
setHistNote(101, "x".repeat(300));
assert("note capped at 200 chars", JSON.parse(sandbox.localStorage.getItem("jdfit_history"))[0].note.length === 200);
setHistStatus(999, "已投递"); setHistNote(999, "x"); // unknown id, no crash
assert("unknown id no crash", true);
// new analysis -> history item has default status/note
sandbox.localStorage.setItem("jdfit_history", JSON.stringify([]));
setVal("jdTitle", "状态默认测试");
setVal("jdCompany", "");
setVal("jdText", "商业分析实习生。负责策略与洞察复盘。");
sandbox.analyze();
const h3 = JSON.parse(sandbox.localStorage.getItem("jdfit_history"));
assert("new history item has default status 未投递", h3[0].status === "未投递");
assert("new history item has empty note", h3[0].note === "");
// escAttr escapes quotes for attribute injection safety
assert("escAttr escapes double quotes", escAttr('a"b<c') === 'a&quot;b&lt;c');
assert("escAttr escapes single quotes", escAttr("a'b").indexOf("&#39;") >= 0);

console.log("=== Test 13: version + privacy ===");
const code3 = fs.readFileSync("index.html", "utf8");
assert("footer shows v0.8", code3.includes("JD适配判断器 v0.8"));
assert("resume card present", code3.includes("id=\"resumeCard\""));
assert("clear button present", code3.includes("clearJDInputs"));
assert("status select present", code3.includes("setHistStatus"));
assert("note input present", code3.includes("setHistNote"));
assert("no 罗景怡 (privacy)", !code3.includes("罗景怡"));
assert("no HCR (privacy)", !code3.includes("HCR"));
assert("no 中央财经 (privacy)", !code3.includes("中央财经"));

console.log("=== Test 14: AI 深度分析模块 ===");
const AI_BACKEND_URL = exportFn("AI_BACKEND_URL");
const buildAIReportHTML = exportFn("buildAIReportHTML");
const currentResumeTextForAI = exportFn("currentResumeTextForAI");
assert("AI_BACKEND_URL points to worker", AI_BACKEND_URL === "https://zhijue-backend.luojingyi417.workers.dev");
assert("aiAnalyze function exists", typeof exportFn("aiAnalyze") === "function");
assert("aiBox rendered in HTML", code3.includes('id="aiBox"'));
assert("AI card has privacy notice", code3.includes("发送到你自己的后端"));
// currentResumeTextForAI: prefers editor content, falls back to saved resume
setVal("resumeText", "编辑区简历内容");
assert("currentResumeTextForAI prefers editor", currentResumeTextForAI() === "编辑区简历内容");
setVal("resumeText", "");
sandbox.currentResumeId = null;
assert("currentResumeTextForAI empty when nothing saved", currentResumeTextForAI() === "");
// buildAIReportHTML renders report structure
const sampleReport = {
  verdict: "推荐投递", overallScore: 78,
  dimensions: [{name: "技能匹配", score: 8, comment: "Excel对口"}],
  strengths: ["数据分析扎实"], gaps: ["SQL需加强"], resumeSuggestions: ["补充用户分层关键词"],
  summary: "整体匹配度较高。"
};
const reportHTML = buildAIReportHTML(sampleReport);
assert("report renders verdict", reportHTML.includes("推荐投递"));
assert("report renders score", reportHTML.includes("78"));
assert("report renders dimension row", reportHTML.includes("技能匹配") && reportHTML.includes("Excel对口"));
assert("report renders strengths", reportHTML.includes("数据分析扎实"));
assert("report renders gaps", reportHTML.includes("SQL需加强"));
assert("report renders suggestions", reportHTML.includes("补充用户分层关键词"));
assert("report has human-judgment disclaimer", reportHTML.includes("AI做执行，人做判断"));
// XSS safety: report content is escaped
const xssReport = {verdict: '<img src=x onerror=alert(1)>', dimensions: [], strengths: ["<script>bad()</script>"], gaps: [], resumeSuggestions: [], summary: ""};
const xssHTML = buildAIReportHTML(xssReport);
assert("XSS: script content escaped", !xssHTML.includes("<script>bad"));
assert("XSS: img tag not executable", !xssHTML.includes("<img") && xssHTML.includes("&lt;img"));
// edge cases
assert("null report returns empty", buildAIReportHTML(null) === "");
assert("empty arrays render dash", buildAIReportHTML({verdict: "谨慎投递", dimensions: [], strengths: [], gaps: [], resumeSuggestions: []}).includes("—"));
assert("verdict emoji: 推荐=green", buildAIReportHTML(sampleReport).includes("🟢"));
assert("verdict emoji: 不建议=red", buildAIReportHTML({...sampleReport, verdict: "不建议投递"}).includes("🔴"));

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
assert("overwrite confirm guard present", code3.includes("上传将覆盖编辑区当前的简历内容"));
assert("too-short text guard present", code3.includes("识别出的文字太少"));
assert("doc old-format rejection message present", code3.includes(".doc 老格式浏览器无法解析"));
assert("upload stays local (privacy wording)", code3.includes("本地解析，文件不上传"));
// 隐私：CDN 域名白名单不含私有地址
assert("no localhost in lib urls", !JSON.stringify(LIBS).includes("localhost"));
assert("no 127.0.0.1 in lib urls", !JSON.stringify(LIBS).includes("127.0.0.1"));

console.log("=== Test 16: 贴JD区对比简历选择器 ===");
assert("jdResumeSel selector present", code3.includes('id="jdResumeSel"'));
assert("selector wired to pickResumeForCompare", code3.includes("onchange=\"pickResumeForCompare(this.value)\""));
assert("picker message element present", code3.includes('id="jdResumeMsg"'));
assert("pickResumeForCompare is function", typeof exportFn("pickResumeForCompare") === "function");
assert("renderJDResumeSel is function", typeof exportFn("renderJDResumeSel") === "function");
// renderPasteFromBank 同步刷新对比选择器
assert("renderPasteFromBank refreshes jd selector", code3.includes("renderPasteFromBank(){") && code3.split("renderPasteFromBank(){")[1].split("}")[0].includes("renderJDResumeSel()") || code3.includes("renderJDResumeSel();"));
// 选择后载入编辑区（loadResumeToEditor 联动）
assert("pick loads resume into editor", code3.includes("pickResumeForCompare") && code3.split("function pickResumeForCompare")[1].split("\n").slice(0,8).join("\n").includes("loadResumeToEditor"));
// 选择器列出已存简历
sandbox.jdResumeSel = undefined; // fakeEl 已按 id 提供
setVal("resumeName", "运营版");
setVal("resumeText", "运营简历正文：用户分层、转化分析。");
sandbox.saveResume();
sandbox.renderJDResumeSel();
const selEl = sandbox.document.getElementById("jdResumeSel");
assert("jdResumeSel lists saved resume", selEl._html.includes("运营版"));
assert("jdResumeSel has placeholder option", selEl._html.includes("选择一份储备简历用于对比"));
// 无简历时选择器仅有占位
sandbox.localStorage.removeItem("jdfit_resumes");
sandbox.currentResumeId = null;
sandbox.renderJDResumeSel();
assert("jdResumeSel empty bank shows only placeholder", selEl._html.includes("选择一份储备简历用于对比") && !selEl._html.includes("运营版"));

console.log("\n=== Results: " + pass + " passed, " + fail + " failed ===");
if (fail > 0) process.exit(1);
