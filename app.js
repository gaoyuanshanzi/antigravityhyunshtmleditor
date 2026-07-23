/* ==========================================================================
   AetherEdit Core Logic
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
    initApp();
});

// Global state
let activeFile = null;
let codeEditor = null;
let workspaceDb = null;
let isSyncing = false;
let autoSaveTimeout = null;
let layoutGuidesActive = false;
let savedRange = null;
let currentTextColor = "#ef4444";
let currentHighlightColor = "#fef08a";

// Restore the saved selection range inside the preview iframe
function restoreSelection() {
    if (!savedRange) return;
    const iframe = document.getElementById("preview-iframe");
    if (!iframe || !iframe.contentWindow) return;
    try {
        const sel = iframe.contentWindow.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
    } catch (e) {
        // Range may be stale if DOM changed; ignore
    }
}

// Credentials
const ADMIN_USER = "admin";
const ADMIN_PASS = "123jesus";

/* ==========================================================================
   1. APP INITIALIZATION
   ========================================================================== */
async function initApp() {
    // Initialize Lucide Icons
    lucide.createIcons();

    // Setup Split Pane Resizing
    initResizers();

    // Initialize Database
    workspaceDb = new WorkspaceDB();
    try {
        await workspaceDb.open();
    } catch (err) {
        console.error("Database failed to initialize:", err);
    }

    // Setup Auth Check
    checkAuthSession();

    // Bind Event Listeners
    bindEvents();
}

/* ==========================================================================
   2. AUTHENTICATION CONTROLLER
   ========================================================================== */
function checkAuthSession() {
    const isLoggedIn = sessionStorage.getItem("ae_logged_in") === "true";
    if (isLoggedIn) {
        showAppScreen();
    } else {
        showAuthScreen();
    }
}

function showAuthScreen() {
    document.getElementById("auth-screen").classList.add("active");
    document.getElementById("app-screen").classList.remove("active");
}

function showAppScreen() {
    document.getElementById("auth-screen").classList.remove("active");
    document.getElementById("app-screen").classList.add("active");
    
    // Load files inside workspace
    loadWorkspace();
}

// NOTE: Login and logout listeners are registered in bindEvents()
// which runs after DOMContentLoaded to ensure elements exist.

// CSS shake animation keyframe inject for password failures
const styleSheet = document.createElement("style");
styleSheet.innerText = `
@keyframes shake {
    0%, 100% { transform: translateX(0); }
    20%, 60% { transform: translateX(-8px); }
    40%, 80% { transform: translateX(8px); }
}`;
document.head.appendChild(styleSheet);


/* ==========================================================================
   3. INDEXEDDB WORKSPACE MANAGER
   ========================================================================== */
class WorkspaceDB {
    constructor() {
        this.dbName = "AetherEditWorkspace";
        this.dbVersion = 1;
        this.db = null;
    }

    open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onerror = (e) => reject(e.target.error);
            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains("files")) {
                    db.createObjectStore("files", { keyPath: "id", autoIncrement: true });
                }
                if (!db.objectStoreNames.contains("settings")) {
                    db.createObjectStore("settings", { keyPath: "key" });
                }
            };
        });
    }

    getAllFiles() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(["files"], "readonly");
            const store = transaction.objectStore("files");
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    getFile(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(["files"], "readonly");
            const store = transaction.objectStore("files");
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    saveFile(file) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(["files"], "readwrite");
            const store = transaction.objectStore("files");
            const request = store.put(file);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    deleteFile(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(["files"], "readwrite");
            const store = transaction.objectStore("files");
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    setSetting(key, value) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(["settings"], "readwrite");
            const store = transaction.objectStore("settings");
            const request = store.put({ key, value });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    getSetting(key) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(["settings"], "readonly");
            const store = transaction.objectStore("settings");
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result ? request.result.value : null);
            request.onerror = () => reject(request.error);
        });
    }
}


/* ==========================================================================
   4. FILE EXPLORER (LEFT PLANE) LOGIC
   ========================================================================== */
async function loadWorkspace() {
    const files = await workspaceDb.getAllFiles();
    renderFileList(files);
    
    const lastActiveId = await workspaceDb.getSetting("lastActiveId");
    if (lastActiveId) {
        const file = files.find(f => f.id === lastActiveId);
        if (file) {
            selectFile(file);
            return;
        }
    }
    
    // Fallback if no files or lastActiveId not found
    if (files.length > 0) {
        selectFile(files[0]);
    } else {
        showEmptyWorkspaceState();
    }
}

function renderFileList(files) {
    const fileListEl = document.getElementById("file-list");
    fileListEl.innerHTML = "";

    if (files.length === 0) {
        fileListEl.innerHTML = `
            <div class="file-list-empty">
                <i data-lucide="folder-open"></i>
                <p>저장된 파일이 없습니다.<br>New 또는 Import 버튼으로 시작하세요.</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }

    const searchQuery = document.getElementById("file-search").value.toLowerCase();
    const filteredFiles = files.filter(f => f.name.toLowerCase().includes(searchQuery));

    filteredFiles.forEach(file => {
        const li = document.createElement("li");
        li.className = `file-item ${activeFile && activeFile.id === file.id ? 'active' : ''}`;
        li.dataset.id = file.id;

        li.innerHTML = `
            <div class="file-item-left">
                <i data-lucide="file-code"></i>
                <span class="file-item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
            </div>
            <div class="file-item-actions">
                <button class="btn-item-delete" title="파일 삭제">
                    <i data-lucide="trash-2"></i>
                </button>
            </div>
        `;

        // Selection event
        li.addEventListener("click", (e) => {
            if (e.target.closest(".btn-item-delete")) return; // skip if delete button clicked
            selectFile(file);
        });

        // Delete event
        li.querySelector(".btn-item-delete").addEventListener("click", async (e) => {
            e.stopPropagation();
            if (confirm(`정말로 '${file.name}' 파일을 삭제하시겠습니까?`)) {
                await workspaceDb.deleteFile(file.id);
                showToast("파일이 삭제되었습니다.");
                if (activeFile && activeFile.id === file.id) {
                    activeFile = null;
                    await workspaceDb.setSetting("lastActiveId", null);
                }
                loadWorkspace();
            }
        });

        fileListEl.appendChild(li);
    });

    lucide.createIcons();
}

function showEmptyWorkspaceState() {
    activeFile = null;
    document.getElementById("active-file-name").textContent = "선택된 파일 없음";
    document.getElementById("editor-container").innerHTML = `
        <div id="editor-placeholder" class="editor-placeholder">
            <i data-lucide="file-code" class="large-icon"></i>
            <p>내비게이터에서 파일을 선택하거나 새로 생성하세요.</p>
        </div>
    `;
    lucide.createIcons();
    const iframe = document.getElementById("preview-iframe");
    iframe.srcdoc = "";
}

async function selectFile(file) {
    activeFile = file;
    await workspaceDb.setSetting("lastActiveId", file.id);
    document.getElementById("active-file-name").textContent = file.name;
    
    // Highlight list item
    document.querySelectorAll(".file-list li").forEach(li => {
        if (parseInt(li.dataset.id) === file.id) {
            li.classList.add("active");
        } else {
            li.classList.remove("active");
        }
    });

    // Initialize/Refresh CodeMirror with file content
    initCodeEditor(file.content);
    
    // Initialize Preview Panel
    initPreviewPanel(file.content);
}

// Escapes HTML for safety
function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

/* ==========================================================================
   5. TWO-WAY EDITING INTERFACES (CENTER & RIGHT PLANES)
   ========================================================================== */
function initCodeEditor(initialContent) {
    const container = document.getElementById("editor-container");
    container.innerHTML = ""; // Clear placeholder
    
    codeEditor = CodeMirror(container, {
        value: initialContent,
        mode: "htmlmixed",
        theme: "dracula",
        lineNumbers: true,
        lineWrapping: true,
        tabSize: 4,
        indentUnit: 4
    });

    // Code Editor Change Handler -> Updates visual pane
    codeEditor.on("change", () => {
        if (isSyncing) return;
        
        triggerAutoSave();
        syncCodeToPreview();
    });
}

function initPreviewPanel(htmlContent) {
    const iframe = document.getElementById("preview-iframe");
    
    // Load content into iframe
    iframe.srcdoc = htmlContent;

    // Attach load listener to wire visual contenteditable editing
    iframe.onload = () => {
        setupIframeVisualEditing();
    };
}

function syncCodeToPreview() {
    isSyncing = true;
    const iframe = document.getElementById("preview-iframe");
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    const currentCode = codeEditor.getValue();

    // If iframe body exists, update just the body elements or complete document depending on tags
    if (doc && doc.body) {
        const bodyContent = getBodyInnerHTML(currentCode);
        const headContent = getHeadInnerHTML(currentCode);

        // Update body inside iframe
        doc.body.innerHTML = bodyContent;

        // Apply visual outline helpers if active
        applyLayoutGuides(doc);
    } else {
        iframe.srcdoc = currentCode;
    }
    
    isSyncing = false;
}

// Extracts contents of <body>...</body> tag for incremental update
function getBodyInnerHTML(htmlStr) {
    const parser = new DOMParser();
    const tempDoc = parser.parseFromString(htmlStr, "text/html");
    // If user specified body content, use it, otherwise use whole text
    if (htmlStr.toLowerCase().includes("<body")) {
        return tempDoc.body.innerHTML;
    }
    return htmlStr; // fallback for fragments
}

// Extracts contents of <head>...</head> tag
function getHeadInnerHTML(htmlStr) {
    const parser = new DOMParser();
    const tempDoc = parser.parseFromString(htmlStr, "text/html");
    if (htmlStr.toLowerCase().includes("<head")) {
        return tempDoc.head.innerHTML;
    }
    return "";
}

function setupIframeVisualEditing() {
    const iframe = document.getElementById("preview-iframe");
    const doc = iframe.contentDocument || iframe.contentWindow.document;

    if (!doc || !doc.body) return;

    // Make body editable
    doc.body.contentEditable = "true";

    // Setup base styles inside iframe if not present
    if (!doc.getElementById("aether-preview-styles")) {
        const style = doc.createElement("style");
        style.id = "aether-preview-styles";
        style.innerHTML = `
            body {
                min-height: 100vh;
                padding: 10px;
                box-sizing: border-box;
                font-family: sans-serif;
            }
            body:empty::before {
                content: '텍스트를 입력하여 웹페이지 작성을 시작하세요...';
                color: #999;
                font-style: italic;
            }
            /* Visual editing outlines when helper activated */
            body.show-guides * {
                outline: 1px dashed rgba(139, 92, 246, 0.35) !important;
                outline-offset: 2px;
            }
            body.show-guides *:focus {
                outline: 1px solid #8b5cf6 !important;
                background-color: rgba(139, 92, 246, 0.03);
            }
        `;
        doc.head.appendChild(style);
    }

    if (layoutGuidesActive) {
        doc.body.classList.add("show-guides");
    }

    // Attach events inside iframe to capture user changes in real-time
    const handleVisualInput = (e) => {
        if (isSyncing) return;
        syncPreviewToCode(doc);
    };

    // Listen to keypress, mouse release, paste, cut inside iframe
    doc.body.addEventListener("input", handleVisualInput);
    doc.body.addEventListener("keyup", handleVisualInput);
    doc.body.addEventListener("mouseup", handleVisualInput);
    doc.body.addEventListener("paste", handleVisualInput);
    doc.body.addEventListener("cut", handleVisualInput);

    // Track active selection range inside the iframe document
    doc.addEventListener("selectionchange", () => {
        const sel = iframe.contentWindow.getSelection();
        if (sel.rangeCount > 0) {
            savedRange = sel.getRangeAt(0);
        }
    });
}

function syncPreviewToCode(doc) {
    isSyncing = true;

    // Clone the doc to remove helpers/stylesheets before writing back to source code
    const docClone = doc.documentElement.cloneNode(true);
    
    // Remove custom visual editing styles and helper attributes before parsing HTML
    const helperStyle = docClone.querySelector("#aether-preview-styles");
    if (helperStyle) helperStyle.remove();

    const bodyEl = docClone.querySelector("body");
    if (bodyEl) {
        bodyEl.removeAttribute("contenteditable");
        bodyEl.classList.remove("show-guides");
    }

    // Generate output code
    let outputCode = "";
    
    // Determine if original input was a full HTML document or fragment
    const originalCode = codeEditor.getValue();
    const hasHtmlTag = originalCode.toLowerCase().includes("<html");
    const hasBodyTag = originalCode.toLowerCase().includes("<body");

    if (hasHtmlTag) {
        outputCode = "<!DOCTYPE html>\n" + docClone.outerHTML;
    } else if (hasBodyTag) {
        const headHtml = docClone.querySelector("head").innerHTML.trim();
        const bodyHtml = docClone.querySelector("body").innerHTML;
        
        outputCode = "";
        if (headHtml) {
            outputCode += `<head>\n${indentString(headHtml, 4)}\n</head>\n`;
        }
        outputCode += `<body>\n${indentString(bodyHtml, 4)}\n</body>`;
    } else {
        // Just fragment
        outputCode = docClone.querySelector("body").innerHTML;
    }

    // Clean up empty lines or trailing content if required, and write to CodeMirror
    const cursor = codeEditor.getCursor();
    codeEditor.setValue(outputCode);
    codeEditor.setCursor(cursor); // Maintain cursor position

    triggerAutoSave();
    
    isSyncing = false;
}

// Indent code strings for nicer format
function indentString(str, spaces) {
    const pad = " ".repeat(spaces);
    return str.split("\n").map(line => pad + line).join("\n");
}

function applyLayoutGuides(doc) {
    if (layoutGuidesActive) {
        doc.body.classList.add("show-guides");
    } else {
        doc.body.classList.remove("show-guides");
    }
}


/* ==========================================================================
   6. AUTO-SAVE LOGIC
   ========================================================================== */
function triggerAutoSave() {
    if (!activeFile) return;

    // Update status dot/text to saving
    const statusDot = document.getElementById("save-status-dot");
    const statusText = document.getElementById("save-status-text");
    statusDot.className = "save-status-dot saving";
    statusText.textContent = "저장 중...";

    // Clear existing timer
    if (autoSaveTimeout) clearTimeout(autoSaveTimeout);

    // Debounce save for 1.2 seconds of typing pause
    autoSaveTimeout = setTimeout(async () => {
        if (!activeFile) return;
        
        activeFile.content = codeEditor.getValue();
        activeFile.modified = Date.now();
        
        await workspaceDb.saveFile(activeFile);
        
        // Return status to saved
        statusDot.className = "save-status-dot saved";
        statusText.textContent = "저장 완료";
    }, 1200);
}


/* ==========================================================================
   7. FILE CREATION, IMPORT & INITIAL DOWNLOAD
   ========================================================================== */
   
// Helper to automatically trigger download on file creation/import
function triggerInitialDownload(filename, content) {
    const blob = new Blob([content], { type: "text/html;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Confirm file rename
async function renameActiveFile(newFilename) {
    if (!activeFile) return;
    if (!newFilename.endsWith(".html") && !newFilename.endsWith(".htm")) {
        newFilename += ".html";
    }

    const files = await workspaceDb.getAllFiles();
    const duplicate = files.find(f => f.name.toLowerCase() === newFilename.toLowerCase() && f.id !== activeFile.id);
    
    if (duplicate) {
        alert("동일한 이름의 파일이 이미 존재합니다.");
        return false;
    }

    activeFile.name = newFilename;
    activeFile.modified = Date.now();
    await workspaceDb.saveFile(activeFile);
    
    document.getElementById("active-file-name").textContent = newFilename;
    showToast("파일 이름이 변경되었습니다.");
    loadWorkspace();
    return true;
}

/* ==========================================================================
   8. EXPORT ENGINE
   ========================================================================== */
async function exportActiveFile(format) {
    if (!activeFile) {
        alert("수출할 파일이 없습니다. 먼저 파일을 선택하세요.");
        return;
    }

    const htmlContent = codeEditor ? codeEditor.getValue() : (activeFile ? activeFile.content : "");
    const baseName = activeFile.name.replace(/\.html?$/, '');
    
    switch (format) {
        case "html":
            exportToHTML(baseName, htmlContent);
            break;
        case "pdf":
            exportToPDF(baseName);
            break;
        case "epub":
            exportToEPUB(baseName, htmlContent);
            break;
        case "txt":
            exportToTXT(baseName, htmlContent);
            break;
        case "rtf":
            exportToRTF(baseName, htmlContent);
            break;
        case "word":
            exportToWord(baseName, htmlContent);
            break;
        case "hwp":
            exportToHWP(baseName, htmlContent);
            break;
        case "md":
            exportToMD(baseName, htmlContent);
            break;
        case "csv":
            exportToCSV(baseName, htmlContent);
            break;
        case "json":
            exportToJSON(activeFile);
            break;
        default:
            console.error("Unknown export format: " + format);
    }
}

// 0) HTML Export
function exportToHTML(baseName, htmlContent) {
    const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8;" });
    downloadBlob(blob, `${baseName}.html`);
    showToast("HTML 파일 다운로드 완료");
}

// 1) PDF Export (using html2pdf.js)
function exportToPDF(baseName) {
    showToast("PDF 생성을 시작합니다...");

    const iframe = document.getElementById("preview-iframe");
    if (!iframe || !iframe.contentWindow) {
        alert("프리뷰 에디터를 찾을 수 없습니다.");
        return;
    }

    const previewDoc = iframe.contentDocument || iframe.contentWindow.document;
    const body = previewDoc.body;

    if (!body) {
        alert("PDF로 변환할 내용이 없습니다.");
        return;
    }

    // Save original styles of html and body
    const origHtmlStyle = previewDoc.documentElement.getAttribute("style");
    const origBodyStyle = body.getAttribute("style");

    // Force html and body backgrounds to pure white
    previewDoc.documentElement.style.setProperty("background-color", "#ffffff", "important");
    previewDoc.documentElement.style.setProperty("background", "#ffffff", "important");
    previewDoc.documentElement.style.setProperty("color", "#1f2937", "important");

    body.style.setProperty("background-color", "#ffffff", "important");
    body.style.setProperty("background", "#ffffff", "important");
    body.style.setProperty("color", "#1f2937", "important");
    body.style.setProperty("height", "auto", "important");
    body.style.setProperty("min-height", "100%", "important");
    body.style.setProperty("max-height", "none", "important");
    body.style.setProperty("overflow", "visible", "important");

    // Scan all DOM elements using Computed Styles to neutralize dark mode
    const modifiedStyles = [];
    const allElements = body.querySelectorAll("*");

    allElements.forEach(el => {
        const computed = previewDoc.defaultView.getComputedStyle(el);
        const computedBg = computed.backgroundColor;
        const computedColor = computed.color;

        let isDarkBg = false;
        if (computedBg && computedBg !== "transparent" && computedBg !== "rgba(0, 0, 0, 0)") {
            const match = computedBg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (match) {
                const r = parseInt(match[1]), g = parseInt(match[2]), b = parseInt(match[3]);
                const luma = (r * 299 + g * 587 + b * 114) / 1000;
                // If computed background is dark (Luma < 160), force to white
                if (luma < 160) {
                    isDarkBg = true;
                }
            }
        }

        let isLightText = false;
        if (computedColor) {
            const match = computedColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (match) {
                const r = parseInt(match[1]), g = parseInt(match[2]), b = parseInt(match[3]);
                const luma = (r * 299 + g * 587 + b * 114) / 1000;
                // If computed text color is light/white (Luma > 160), convert to dark gray #1f2937
                if (luma > 160) {
                    isLightText = true;
                }
            }
        }

        const origStyle = el.getAttribute("style");
        let changed = false;

        if (isDarkBg) {
            el.style.setProperty("background-color", "#ffffff", "important");
            el.style.setProperty("background", "#ffffff", "important");
            changed = true;
        }

        if (isLightText) {
            el.style.setProperty("color", "#1f2937", "important");
            changed = true;
        }

        if (changed) {
            modifiedStyles.push({ el, origStyle });
        }
    });

    const isEditable = body.getAttribute("contenteditable");
    body.removeAttribute("contenteditable");
    const hadGuides = body.classList.contains("show-guides");
    body.classList.remove("show-guides");

    const restoreDoc = () => {
        if (origHtmlStyle !== null) {
            previewDoc.documentElement.setAttribute("style", origHtmlStyle);
        } else {
            previewDoc.documentElement.removeAttribute("style");
        }

        if (origBodyStyle !== null) {
            body.setAttribute("style", origBodyStyle);
        } else {
            body.removeAttribute("style");
        }

        if (isEditable !== null) body.setAttribute("contenteditable", isEditable);
        if (hadGuides) body.classList.add("show-guides");

        // Restore modified inline styles
        modifiedStyles.forEach(item => {
            if (item.origStyle !== null) {
                item.el.setAttribute("style", item.origStyle);
            } else {
                item.el.removeAttribute("style");
            }
        });
    };

    // Calculate full document scroll height across all 12+ pages
    const fullHeight = Math.max(
        body.scrollHeight,
        body.offsetHeight,
        previewDoc.documentElement.scrollHeight,
        previewDoc.documentElement.offsetHeight
    );

    const opt = {
        margin: [10, 10, 10, 10],
        filename: `${baseName}.pdf`,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: {
            scale: 2,
            useCORS: true,
            allowTaint: true,
            backgroundColor: "#ffffff",
            height: fullHeight,
            windowHeight: fullHeight,
            scrollY: 0,
            scrollX: 0
        },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["avoid-all", "css", "legacy"] }
    };

    setTimeout(() => {
        html2pdf()
            .set(opt)
            .from(body)
            .save()
            .then(() => {
                showToast("PDF 다운로드 완료");
                restoreDoc();
            })
            .catch(err => {
                console.error("html2pdf failed:", err);
                try {
                    iframe.contentWindow.focus();
                    iframe.contentWindow.print();
                    showToast("인쇄/PDF 저장 창을 열었습니다.");
                } catch (printErr) {
                    alert("PDF 변환 중 오류가 발생했습니다.");
                }
                restoreDoc();
            });
    }, 200);
}

// 2) EPUB Export (using JSZip)
function exportToEPUB(baseName, htmlContent) {
    showToast("EPUB 생성을 시작합니다...");
    const zip = new JSZip();

    // EPUB Standard file contents
    // 1. mimetype (Must be uncompressed, but default JSZip is fine for basic reader imports)
    zip.file("mimetype", "application/epub+zip");

    // 2. META-INF/container.xml
    zip.file("META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

    // 3. OEBPS/content.opf (Manifest)
    zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${baseName}</dc:title>
    <dc:creator>AetherEdit</dc:creator>
    <dc:language>ko</dc:language>
    <dc:identifier id="BookId">urn:uuid:${Math.random().toString(36).substring(2, 15)}</dc:identifier>
  </metadata>
  <manifest>
    <item id="content" href="content.html" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="content"/>
  </spine>
</package>`);

    // 4. OEBPS/toc.ncx (Table of Contents)
    zip.file("OEBPS/toc.ncx", `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD NCX V1.0//EN" "http://www.daisy.org/z3986/2005/ncx-1.0.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:12345"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>${baseName}</text>
  </docTitle>
  <navMap>
    <navPoint id="navpoint-1" playOrder="1">
      <navLabel>
        <text>시작페이지</text>
      </navLabel>
      <content src="content.html"/>
    </navPoint>
  </navMap>
</ncx>`);

    // Ensure content is XHTML compliant (for basic export, wrap raw HTML into a clean skeleton)
    const xhtmlContent = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${baseName}</title>
</head>
<body>
  ${getBodyInnerHTML(htmlContent)}
</body>
</html>`;

    zip.file("OEBPS/content.html", xhtmlContent);

    // Generate Zip Blob and trigger download
    zip.generateAsync({ type: "blob" }).then((blob) => {
        downloadBlob(blob, `${baseName}.epub`);
        showToast("EPUB 다운로드 완료");
    });
}

// 3) TXT Export
function exportToTXT(baseName, htmlContent) {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = htmlContent;
    
    // Remove style and script elements to prevent style definitions from printing in txt
    tempDiv.querySelectorAll("style, script").forEach(el => el.remove());
    
    const plainText = tempDiv.textContent || tempDiv.innerText || "";
    
    const blob = new Blob([plainText], { type: "text/plain;charset=utf-8;" });
    downloadBlob(blob, `${baseName}.txt`);
    showToast("TXT 다운로드 완료");
}

// 4) RTF Export
function exportToRTF(baseName, htmlContent) {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = htmlContent;
    
    // Translate basic HTML structures into simple RTF formatting syntax
    let rtfContent = tempDiv.innerHTML
        .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '\\b $1\\b0 ')
        .replace(/<b[^>]*>(.*?)<\/b>/gi, '\\b $1\\b0 ')
        .replace(/<em[^>]*>(.*?)<\/em>/gi, '\\i $1\\i0 ')
        .replace(/<i[^>]*>(.*?)<\/i>/gi, '\\i $1\\i0 ')
        .replace(/<p[^>]*>(.*?)<\/p>/gi, '\\par $1\\par ')
        .replace(/<br\s*\/?>/gi, '\\par ')
        .replace(/<li[^>]*>(.*?)<\/li>/gi, '\\par  - $1')
        .replace(/<\/?[^>]+(>|$)/g, ""); // Strip other tags
        
    // Wrap in standard RTF header
    const rtfDoc = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fnil\\fcharset129 Gulim;\\f1\\fnil\\fcharset0 Arial;}}\\f0\\fs24 ${rtfContent}}`;
    
    const blob = new Blob([rtfDoc], { type: "application/rtf;charset=utf-8;" });
    downloadBlob(blob, `${baseName}.rtf`);
    showToast("RTF 다운로드 완료");
}

// 5) Word Export (.doc)
function exportToWord(baseName, htmlContent) {
    // Generate a valid MHTML or complete HTML format that Word opens styled
    const wordContent = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
        <meta charset="utf-8">
        <title>${baseName}</title>
        <!--[if gte mso 9]>
        <xml>
            <w:WordDocument>
                <w:View>Print</w:View>
                <w:Zoom>100</w:Zoom>
            </w:WordDocument>
        </xml>
        <![endif]-->
    </head>
    <body>
        ${htmlContent}
    </body>
    </html>
    `;
    const blob = new Blob([wordContent], { type: "application/msword;charset=utf-8;" });
    downloadBlob(blob, `${baseName}.doc`);
    showToast("MS Word (.doc) 다운로드 완료");
}

// 6) HWP Export (.hwp)
function exportToHWP(baseName, htmlContent) {
    // Because HWP binary format is complex, Hancom Word loads styled HTML format directly
    // when named with a .hwp extension. We provide a well-formed HTML wrapper for compatibility.
    const hwpCompatibleContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>${baseName}</title>
        <style>
            body { font-family: "Batang", "Gulim", serif; font-size: 12pt; line-height: 1.6; }
        </style>
    </head>
    <body>
        ${htmlContent}
    </body>
    </html>
    `;
    const blob = new Blob([hwpCompatibleContent], { type: "application/x-hwp;charset=utf-8;" });
    downloadBlob(blob, `${baseName}.hwp`);
    showToast("HWP 파일 다운로드 완료");
}

// 7) MD Export (using Turndown.js)
function exportToMD(baseName, htmlContent) {
    if (typeof TurndownService === 'undefined') {
        alert("Markdown 변환 라이브러리를 로드할 수 없습니다.");
        return;
    }
    const turndownService = new TurndownService({ headingStyle: 'atx' });
    const markdown = turndownService.turndown(htmlContent);

    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8;" });
    downloadBlob(blob, `${baseName}.md`);
    showToast("Markdown 다운로드 완료");
}

// 8) CSV Export (Parse Table element)
function exportToCSV(baseName, htmlContent) {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = htmlContent;
    
    const tables = tempDiv.getElementsByTagName("table");
    let csvData = "";

    if (tables.length > 0) {
        // Extract rows from the first table found
        const rows = tables[0].querySelectorAll("tr");
        rows.forEach(row => {
            const cols = row.querySelectorAll("th, td");
            const rowArr = Array.from(cols).map(col => {
                // escape double quotes by doubling them, wrap in quotes
                const text = col.textContent.replace(/"/g, '""').trim();
                return `"${text}"`;
            });
            csvData += rowArr.join(",") + "\r\n";
        });
    } else {
        // Fallback if no table found: extract headings and text blocks
        csvData = `"파일명","텍스트 내용"\r\n"${baseName}","${tempDiv.textContent.replace(/"/g, '""').trim()}"`;
    }

    const blob = new Blob([csvData], { type: "text/csv;charset=utf-8;" });
    downloadBlob(blob, `${baseName}.csv`);
    showToast("CSV 다운로드 완료");
}

// 9) JSON Export
function exportToJSON(fileObj) {
    const jsonStr = JSON.stringify({
        title: fileObj.name,
        content: fileObj.content,
        created: fileObj.created,
        modified: fileObj.modified,
        app: "AetherEdit"
    }, null, 4);

    const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8;" });
    downloadBlob(blob, `${fileObj.name.replace(/\.html?$/, '')}.json`);
    showToast("JSON 데이터 다운로드 완료");
}

// Helper to trigger file download
function downloadBlob(blob, filename) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}


/* ==========================================================================
   9. INTERACTION CONTROLLER & SPLITTERS
   ========================================================================== */

// Split panel drag resize controls
function initResizers() {
    const splitLeft = document.getElementById("splitter-left");
    const splitRight = document.getElementById("splitter-right");
    const paneLeft = document.getElementById("pane-left");
    const paneCenter = document.getElementById("pane-center");
    const paneRight = document.getElementById("pane-right");
    const workspace = document.querySelector(".app-workspace");

    // Resize Left Panel
    splitLeft.addEventListener("mousedown", (e) => {
        e.preventDefault();
        splitLeft.classList.add("dragging");
        
        const doDrag = (e) => {
            const workspaceRect = workspace.getBoundingClientRect();
            let newWidth = e.clientX - workspaceRect.left;
            
            // Boundary constraints
            if (newWidth > 200 && newWidth < 450) {
                paneLeft.style.width = newWidth + "px";
            }
        };

        const stopDrag = () => {
            splitLeft.classList.remove("dragging");
            document.removeEventListener("mousemove", doDrag);
            document.removeEventListener("mouseup", stopDrag);
        };

        document.addEventListener("mousemove", doDrag);
        document.addEventListener("mouseup", stopDrag);
    });

    // Resize Right Panel
    splitRight.addEventListener("mousedown", (e) => {
        e.preventDefault();
        splitRight.classList.add("dragging");

        const doDrag = (e) => {
            const workspaceRect = workspace.getBoundingClientRect();
            let newWidth = workspaceRect.right - e.clientX;

            // Boundary constraints
            if (newWidth > 250 && newWidth < (workspaceRect.width * 0.6)) {
                paneRight.style.width = newWidth + "px";
            }
        };

        const stopDrag = () => {
            splitRight.classList.remove("dragging");
            document.removeEventListener("mousemove", doDrag);
            document.removeEventListener("mouseup", stopDrag);
        };

        document.addEventListener("mousemove", doDrag);
        document.addEventListener("mouseup", stopDrag);
    });
}

function bindEvents() {
    // --- Login Form Submit ---
    const loginForm = document.getElementById("login-form");
    if (loginForm) {
        loginForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const userVal = document.getElementById("username").value.trim();
            const passVal = document.getElementById("password").value;
            const errorMsg = document.getElementById("login-error");

            if (userVal === ADMIN_USER && passVal === ADMIN_PASS) {
                errorMsg.classList.add("hidden");
                sessionStorage.setItem("ae_logged_in", "true");
                showAppScreen();
                showToast("관리자 로그인 성공");
            } else {
                errorMsg.classList.remove("hidden");
                const card = document.querySelector(".auth-card");
                card.style.animation = "none";
                card.offsetHeight;
                card.style.animation = "shake 0.4s ease";
            }
        });
    }

    // --- Logout Button ---
    const logoutBtn = document.getElementById("logout-btn");
    if (logoutBtn) {
        logoutBtn.addEventListener("click", () => {
            sessionStorage.removeItem("ae_logged_in");
            activeFile = null;
            if (codeEditor) {
                try { codeEditor.toTextArea(); } catch(e) {}
                codeEditor = null;
            }
            document.getElementById("editor-container").innerHTML = `
                <div id="editor-placeholder" class="editor-placeholder">
                    <i data-lucide="file-code" class="large-icon"></i>
                    <p>내비게이터에서 파일을 선택하거나 새로 생성하세요.</p>
                </div>
            `;
            lucide.createIcons();
            const iframe = document.getElementById("preview-iframe");
            if (iframe) iframe.srcdoc = "";
            const activeFileName = document.getElementById("active-file-name");
            if (activeFileName) activeFileName.textContent = "선택된 파일 없음";
            showAuthScreen();
            showToast("로그아웃 되었습니다.");
        });
    }

    // --- New File Modal Events ---
    const newFileBtn = document.getElementById("new-file-btn");
    const newFileModal = document.getElementById("new-file-modal");
    const newFileConfirm = document.getElementById("new-file-confirm");
    const newFileCancel = document.getElementById("new-file-cancel");
    const newFileInput = document.getElementById("new-file-input");

    newFileBtn.addEventListener("click", () => {
        newFileInput.value = "";
        newFileModal.classList.remove("hidden");
        newFileModal.classList.add("active");
        setTimeout(() => newFileInput.focus(), 50);
    });

    newFileCancel.addEventListener("click", () => {
        newFileModal.classList.remove("active");
        newFileModal.classList.add("hidden");
    });

    newFileModal.addEventListener("click", (e) => {
        if (e.target === newFileModal) {
            newFileModal.classList.remove("active");
            newFileModal.classList.add("hidden");
        }
    });

    newFileConfirm.addEventListener("click", async () => {
        let filename = newFileInput.value.trim();
        if (!filename) {
            alert("파일 이름을 입력해 주세요.");
            return;
        }
        if (!filename.endsWith(".html") && !filename.endsWith(".htm")) {
            filename += ".html";
        }

        // Validate duplicates
        const files = await workspaceDb.getAllFiles();
        if (files.some(f => f.name.toLowerCase() === filename.toLowerCase())) {
            alert("동일한 이름의 파일이 이미 존재합니다.");
            return;
        }

        // Create new file structure
        const blankContent = `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <title>${filename.replace(/\.html?$/, '')}</title>
</head>
<body>
    <h1>새로운 문서가 생성되었습니다.</h1>
    <p>여기에 내용을 작성하세요.</p>
</body>
</html>`;

        const newFileObj = {
            name: filename,
            content: blankContent,
            created: Date.now(),
            modified: Date.now()
        };

        const id = await workspaceDb.saveFile(newFileObj);
        newFileObj.id = id;

        newFileModal.classList.remove("active");
        newFileModal.classList.add("hidden");
        showToast("새 파일이 생성되었습니다.");
        
        // Trigger initial download to local download folder
        triggerInitialDownload(filename, blankContent);
        
        await loadWorkspace();
        selectFile(newFileObj);
    });

    // Accept Enter key in new file modal input
    newFileInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            newFileConfirm.click();
        }
    });

    // --- Import File Events ---
    const importBtn = document.getElementById("import-btn");
    const fileImportInput = document.getElementById("file-import-input");

    importBtn.addEventListener("click", () => {
        fileImportInput.click();
    });

    fileImportInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            const content = event.target.result;
            const filename = file.name;

            // Save to Database workspace
            const importedFileObj = {
                name: filename,
                content: content,
                created: Date.now(),
                modified: Date.now()
            };

            const id = await workspaceDb.saveFile(importedFileObj);
            importedFileObj.id = id;

            // Trigger immediate local download for user
            triggerInitialDownload(filename, content);

            showToast("파일을 성공적으로 가져왔습니다.");
            
            // Clear input selection
            fileImportInput.value = "";
            
            await loadWorkspace();
            selectFile(importedFileObj);
        };
        reader.readAsText(file);
    });

    // --- Rename Modal Events ---
    const renameBtn = document.getElementById("rename-file-btn");
    const renameModal = document.getElementById("rename-modal");
    const renameConfirm = document.getElementById("rename-confirm");
    const renameCancel = document.getElementById("rename-cancel");
    const renameInput = document.getElementById("new-filename-input");

    renameBtn.addEventListener("click", () => {
        if (!activeFile) return;
        renameInput.value = activeFile.name;
        renameModal.classList.remove("hidden");
        renameModal.classList.add("active");
        setTimeout(() => renameInput.focus(), 50);
    });

    renameCancel.addEventListener("click", () => {
        renameModal.classList.remove("active");
        renameModal.classList.add("hidden");
    });

    renameModal.addEventListener("click", (e) => {
        if (e.target === renameModal) {
            renameModal.classList.remove("active");
            renameModal.classList.add("hidden");
        }
    });

    renameConfirm.addEventListener("click", async () => {
        const newName = renameInput.value.trim();
        if (newName) {
            const success = await renameActiveFile(newName);
            if (success) {
                renameModal.classList.remove("active");
                renameModal.classList.add("hidden");
            }
        }
    });

    renameInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            renameConfirm.click();
        }
    });

    // --- Search filter ---
    document.getElementById("file-search").addEventListener("input", async () => {
        const files = await workspaceDb.getAllFiles();
        renderFileList(files);
    });

    // --- Visual Guide Toggle ---
    document.getElementById("toggle-borders-btn").addEventListener("click", () => {
        layoutGuidesActive = !layoutGuidesActive;
        const btn = document.getElementById("toggle-borders-btn");
        
        if (layoutGuidesActive) {
            btn.classList.remove("btn-secondary");
            btn.classList.add("btn-primary");
            showToast("레이아웃 격자가 표시됩니다.");
        } else {
            btn.classList.remove("btn-primary");
            btn.classList.add("btn-secondary");
            showToast("레이아웃 격자가 숨겨집니다.");
        }

        // Apply style toggle within preview iframe
        const iframe = document.getElementById("preview-iframe");
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        if (doc && doc.body) {
            applyLayoutGuides(doc);
        }
    });

    // --- Preview Responsive Simulator ---
    const widthToggleBtn = document.getElementById("preview-width-toggle");
    const iframeWrapper = document.getElementById("preview-iframe-wrapper");
    
    // Modes cycle: fullwidth -> tablet -> mobile -> fullwidth
    let currentMode = "full"; 
    widthToggleBtn.addEventListener("click", () => {
        const icon = widthToggleBtn.querySelector("i");
        if (currentMode === "full") {
            currentMode = "tablet";
            iframeWrapper.className = "preview-iframe-wrapper tablet";
            widthToggleBtn.title = "모바일 크기로 보기";
            icon.setAttribute("data-lucide", "tablet");
            showToast("태블릿 해상도로 가상화합니다.");
        } else if (currentMode === "tablet") {
            currentMode = "mobile";
            iframeWrapper.className = "preview-iframe-wrapper mobile";
            widthToggleBtn.title = "전체 화면으로 보기";
            icon.setAttribute("data-lucide", "smartphone");
            showToast("모바일 해상도로 가상화합니다.");
        } else {
            currentMode = "full";
            iframeWrapper.className = "preview-iframe-wrapper";
            widthToggleBtn.title = "태블릿 크기로 보기";
            icon.setAttribute("data-lucide", "monitor");
            showToast("전체 PC 해상도로 가상화합니다.");
        }
        lucide.createIcons();
    });

    // --- Export Dropdown Button Trigger ---
    const exportDropdownBtn = document.getElementById("export-dropdown-btn");
    const exportDropdownMenu = document.getElementById("export-dropdown-menu");

    exportDropdownBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        exportDropdownMenu.classList.toggle("hidden");
        exportDropdownMenu.classList.toggle("active");
    });

    // Hide dropdown menu when clicking anywhere else
    document.addEventListener("click", (e) => {
        if (!e.target.closest("#export-dropdown-btn")) {
            exportDropdownMenu.classList.add("hidden");
            exportDropdownMenu.classList.remove("active");
        }
    });

    // Bind export item formats
    exportDropdownMenu.querySelectorAll(".dropdown-item").forEach(item => {
        item.addEventListener("click", (e) => {
            const format = item.dataset.format;
            exportActiveFile(format);
        });
    });

    // --- Visual Editor Formatting Ribbon ---
    const ribbonButtons = document.querySelectorAll(".btn-ribbon[data-cmd]");
    ribbonButtons.forEach(btn => {
        btn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            if (!activeFile) return;

            const cmd = btn.dataset.cmd;
            const iframe = document.getElementById("preview-iframe");
            const doc = iframe.contentDocument || iframe.contentWindow.document;

            iframe.contentWindow.focus();
            doc.execCommand(cmd, false, null);
            syncPreviewToCode(doc);
        });
    });

    // --- Custom Color & Highlight Palettes ---
    
    // Helper to get active iframe documents
    const getIframeDoc = () => {
        const iframe = document.getElementById("preview-iframe");
        return iframe.contentDocument || iframe.contentWindow.document;
    };
    
    const getIframeWin = () => {
        const iframe = document.getElementById("preview-iframe");
        return iframe.contentWindow;
    };

    // Text Color bindings
    const textColorBtn = document.getElementById("ribbon-color-btn");
    const textColorArrow = document.getElementById("ribbon-color-arrow");
    const textColorPalette = document.getElementById("text-color-palette");
    const textColorLine = document.getElementById("text-color-line");
    const textColorPickerInput = document.getElementById("text-color-picker-input");
    const textCustomColorTrigger = document.getElementById("text-custom-color-trigger");

    // Click main text color button -> apply current active text color
    textColorBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (!activeFile) return;

        restoreSelection();
        getIframeWin().focus();
        getIframeDoc().execCommand("foreColor", false, currentTextColor);
        syncPreviewToCode(getIframeDoc());
    });

    // Click arrow button -> toggle text color palette dropdown
    textColorArrow.addEventListener("mousedown", (e) => {
        e.preventDefault();
        textColorPalette.classList.toggle("hidden");
        document.getElementById("bg-color-palette").classList.add("hidden"); // close background palette
    });

    // Select color cell from text grid
    textColorPalette.querySelectorAll(".color-cell").forEach(cell => {
        cell.addEventListener("mousedown", (e) => {
            e.preventDefault();
            const color = cell.dataset.color;
            currentTextColor = color;
            textColorLine.style.backgroundColor = color;
            textColorPalette.classList.add("hidden");

            restoreSelection();
            getIframeWin().focus();
            getIframeDoc().execCommand("foreColor", false, color);
            syncPreviewToCode(getIframeDoc());
        });
    });

    // Custom color trigger
    textCustomColorTrigger.addEventListener("mousedown", (e) => {
        e.preventDefault();
        textColorPickerInput.click();
    });

    // Custom color picker input value changes
    textColorPickerInput.addEventListener("change", () => {
        const color = textColorPickerInput.value;
        currentTextColor = color;
        textColorLine.style.backgroundColor = color;
        textColorPalette.classList.add("hidden");

        restoreSelection();
        getIframeWin().focus();
        getIframeDoc().execCommand("foreColor", false, color);
        syncPreviewToCode(getIframeDoc());
    });

    // Highlight (Background) Color bindings
    const highlightColorBtn = document.getElementById("ribbon-bg-btn");
    const highlightColorArrow = document.getElementById("ribbon-bg-arrow");
    const highlightColorPalette = document.getElementById("bg-color-palette");
    const highlightColorLine = document.getElementById("bg-color-line");
    const highlightColorPickerInput = document.getElementById("bg-color-picker-input");
    const bgCustomColorTrigger = document.getElementById("bg-custom-color-trigger");
    const bgClearTrigger = document.getElementById("bg-clear-trigger");

    // Click main highlight button -> apply current active highlight color
    highlightColorBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (!activeFile) return;

        restoreSelection();
        getIframeWin().focus();
        getIframeDoc().execCommand("hiliteColor", false, currentHighlightColor);
        syncPreviewToCode(getIframeDoc());
    });

    // Click arrow button -> toggle background color palette dropdown
    highlightColorArrow.addEventListener("mousedown", (e) => {
        e.preventDefault();
        highlightColorPalette.classList.toggle("hidden");
        textColorPalette.classList.add("hidden"); // close text color palette
    });

    // Select color cell from background grid
    highlightColorPalette.querySelectorAll(".color-cell").forEach(cell => {
        cell.addEventListener("mousedown", (e) => {
            e.preventDefault();
            const color = cell.dataset.color;
            currentHighlightColor = color;
            highlightColorLine.style.backgroundColor = color;
            highlightColorPalette.classList.add("hidden");

            restoreSelection();
            getIframeWin().focus();
            getIframeDoc().execCommand("hiliteColor", false, color);
            syncPreviewToCode(getIframeDoc());
        });
    });

    // Clear background highlight
    bgClearTrigger.addEventListener("mousedown", (e) => {
        e.preventDefault();
        highlightColorPalette.classList.add("hidden");

        restoreSelection();
        getIframeWin().focus();
        getIframeDoc().execCommand("hiliteColor", false, "transparent");
        syncPreviewToCode(getIframeDoc());
    });

    // Custom background color trigger
    bgCustomColorTrigger.addEventListener("mousedown", (e) => {
        e.preventDefault();
        highlightColorPickerInput.click();
    });

    // Custom background picker input value changes
    highlightColorPickerInput.addEventListener("change", () => {
        const color = highlightColorPickerInput.value;
        currentHighlightColor = color;
        highlightColorLine.style.backgroundColor = color;
        highlightColorPalette.classList.add("hidden");

        restoreSelection();
        getIframeWin().focus();
        getIframeDoc().execCommand("hiliteColor", false, color);
        syncPreviewToCode(getIframeDoc());
    });

    // Hide color popups when clicking anywhere outside of the ribbon groups
    document.addEventListener("mousedown", (e) => {
        const textGroup = document.getElementById("text-color-group");
        const bgGroup = document.getElementById("bg-color-group");
        
        if (textGroup && !textGroup.contains(e.target)) {
            textColorPalette.classList.add("hidden");
        }
        if (bgGroup && !bgGroup.contains(e.target)) {
            highlightColorPalette.classList.add("hidden");
        }
    });

    // Font size selector bindings
    const fontSizeSelect = document.getElementById("ribbon-font-size");
    if (fontSizeSelect) {
        fontSizeSelect.addEventListener("change", () => {
            if (!activeFile) return;
            const sizeVal = fontSizeSelect.value;
            if (sizeVal) {
                const iframe = document.getElementById("preview-iframe");
                const doc = iframe.contentDocument || iframe.contentWindow.document;

                iframe.contentWindow.focus();
                doc.execCommand("fontSize", false, sizeVal);
                syncPreviewToCode(doc);
                
                // Reset select index
                fontSizeSelect.value = "";
            }
        });
    }
}

/* ==========================================================================
   10. TOAST NOTIFICATION UTILITIES
   ========================================================================== */
let toastTimeout = null;
function showToast(message) {
    const toast = document.getElementById("toast");
    const toastMessage = document.getElementById("toast-message");

    toastMessage.textContent = message;
    toast.classList.add("active");

    if (toastTimeout) clearTimeout(toastTimeout);
    
    toastTimeout = setTimeout(() => {
        toast.classList.remove("active");
    }, 2800);
}
