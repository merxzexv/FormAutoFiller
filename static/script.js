// Google Form Auto-Filler - Unified Client Engine
window.formMeta = { questions: [], action_url: '', hidden_fields: {} };
window.formPages = [];
window.currentPageIndex = 0;
window.weightsByEntryId = {};
window.userEditedWeights = {}; // entryId -> Set of manually edited option keys
window.adjustmentMode = 'auto'; // 'auto' | 'manual'
window.currentAddResponseType = 'text';

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

function formatOptionLabel(opt) {
    if (typeof opt === 'string' && opt.startsWith('__GEN_')) {
        const p = opt.split('|');
        if (p.length === 3) {
            if (p[0] === '__GEN_DATE__') return `${p[1]} to ${p[2]}`;
            if (p[0] === '__GEN_TIME__') return `${p[1]} to ${p[2]}`;
            if (p[0] === '__GEN_NUM__') return `${p[1]} to ${p[2]}`;
        }
    }
    return opt;
}

function balanceWeights(vals, target = 100) {
    if (!vals || !vals.length) return [];
    const total = vals.reduce((a, b) => a + b, 0);
    const scaled = total > 0.0001 ? vals.map(v => (v / total) * target) : vals.map(() => target / vals.length);
    const rounded = scaled.map(round2);
    const diff = round2(target - rounded.reduce((a, b) => a + b, 0));
    if (diff !== 0 && rounded.length > 0) {
        let maxIdx = 0;
        for (let i = 1; i < scaled.length; i++) if (scaled[i] > scaled[maxIdx]) maxIdx = i;
        rounded[maxIdx] = round2(rounded[maxIdx] + diff);
    }
    return rounded;
}

window.setAdjustmentMode = function(mode) {
    window.adjustmentMode = mode;
    const autoBtn = document.getElementById('modeAutoBtn');
    const manualBtn = document.getElementById('modeManualBtn');
    if (autoBtn) autoBtn.classList.toggle('active', mode === 'auto');
    if (manualBtn) manualBtn.classList.toggle('active', mode === 'manual');

    if (mode === 'auto') {
        const questions = window.formPages[window.currentPageIndex] || [];
        questions.forEach(q => {
            const card = document.querySelector(`.question-card[data-entry-id="${q.entry_id}"]`);
            if (!card) return;
            const inputs = Array.from(card.querySelectorAll('input[data-option]'));
            if (!inputs.length) return;
            const sum = round2(inputs.reduce((a, b) => a + (parseFloat(b.value) || 0), 0));
            if (Math.abs(sum - 100) > 0.05) {
                handleOptionInputChange(inputs[0], true);
            }
        });
    }

    const curQuestions = window.formPages[window.currentPageIndex] || [];
    curQuestions.forEach(q => updateQuestionStatusNote(null, q.entry_id));
};

function updateQuestionStatusNote(card, entryId) {
    if (!card) card = document.querySelector(`.question-card[data-entry-id="${entryId}"]`);
    if (!card) return;
    const noteEl = card.querySelector('.weight-status-note');
    if (!noteEl) return;

    const inputs = Array.from(card.querySelectorAll('input[data-option]'));
    if (!inputs.length) {
        noteEl.style.display = 'none';
        card.classList.remove('has-weight-error');
        return;
    }

    const sum = round2(inputs.reduce((acc, inp) => acc + (parseFloat(inp.value) || 0), 0));
    const isOk = Math.abs(sum - 100) <= 0.05;

    card.classList.toggle('has-weight-error', !isOk);
    noteEl.style.display = 'flex';
    if (!isOk) {
        noteEl.className = 'weight-status-note warning';
        noteEl.innerHTML = `<i class="bi bi-exclamation-triangle-fill"></i> Weights total ${sum}% (must equal 100%)`;
    } else {
        noteEl.className = 'weight-status-note success';
        noteEl.innerHTML = `<i class="bi bi-check-circle-fill"></i> Total: 100%${window.adjustmentMode === 'auto' ? ' (Auto-balanced)' : ''}`;
    }
}

window.resetQuestionWeights = function(entryId) {
    if (window.userEditedWeights[entryId]) {
        window.userEditedWeights[entryId].clear();
    }
    const q = (window.formMeta.questions || []).find(x => x.entry_id === entryId);
    if (!q) return;
    const keys = getQuestionKeys(q);
    if (!keys.length) return;
    const balanced = balanceWeights(keys.map(() => 1), 100);
    const stored = window.weightsByEntryId[entryId] || (window.weightsByEntryId[entryId] = {});
    keys.forEach((k, idx) => { stored[k] = balanced[idx]; });

    const card = document.querySelector(`.question-card[data-entry-id="${entryId}"]`);
    if (card) {
        card.querySelectorAll('input[data-option]').forEach((inp, idx) => {
            const opt = inp.getAttribute('data-option');
            inp.value = stored[opt] !== undefined ? stored[opt] : balanced[idx];
        });
        updateQuestionStatusNote(card, entryId);
    }
};

window.proceedToAutomation = function() {
    snapshotWeightsFromCurrentPage();
    const invalidQuestions = [];
    (window.formMeta.questions || []).forEach(q => {
        const keys = getQuestionKeys(q);
        if (keys.length > 1) {
            const stored = window.weightsByEntryId[q.entry_id] || {};
            const sum = round2(keys.reduce((acc, k) => acc + (parseFloat(stored[k]) || 0), 0));
            if (Math.abs(sum - 100) > 0.1) {
                invalidQuestions.push({ q, sum });
            }
        }
    });

    if (invalidQuestions.length > 0) {
        const first = invalidQuestions[0];
        showError(`Question "${first.q.text}" weights total ${first.sum}% (must equal 100%). Please adjust or switch to Automatic mode.`);
        if (typeof first.q.page === 'number' && first.q.page !== window.currentPageIndex) {
            showPage(first.q.page);
        }
        return;
    }
    goToPage(3);
};

async function streamNDJSON(url, body, onChunk) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) if (line.trim()) onChunk(JSON.parse(line.trim()));
    }
}

let toastTimers = {};
function showToast(id, msg) {
    const el = document.getElementById(id);
    el.innerText = msg; el.style.display = 'block';
    clearTimeout(toastTimers[id]);
    toastTimers[id] = setTimeout(() => { el.style.display = 'none'; }, 6000);
}
const showError = msg => showToast('error', msg);
const showWarning = msg => showToast('signinWarning', msg);
const hideError = () => { document.getElementById('error').style.display = 'none'; };
const hideWarning = () => { document.getElementById('signinWarning').style.display = 'none'; };
const showLoading = show => {
    document.getElementById('loading').style.display = show ? 'block' : 'none';
    document.getElementById('parseBtn').disabled = show;
};

window.goToPage = function(index) {
    document.getElementById('pageContainer').style.transform = `translateX(-${index * 25}%)`;
    if (index === 2) resetExecutionPhase();
};
window.resetApp = () => location.reload();
window.resetExecutionPhase = () => {
    document.getElementById('inputPhase').style.display = 'block';
    document.getElementById('progressPhase').style.display = 'none';
    document.getElementById('resultPhase').style.display = 'none';
    document.getElementById('progressBar').style.width = '0%';
};

function getQuestionKeys(q) {
    if (q.type === 'linear' || q.type === 'rating') {
        const keys = [];
        const min = typeof q.min === 'number' ? q.min : 1;
        const max = typeof q.max === 'number' ? q.max : 5;
        for (let v = min; v <= max; v++) keys.push(String(v));
        return keys;
    }
    return (q.options || []).slice();
}

function snapshotWeightsFromCurrentPage() {
    const questions = window.formPages[window.currentPageIndex];
    if (!questions) return;
    questions.forEach(q => {
        const card = document.querySelector(`.question-card[data-entry-id="${q.entry_id}"]`);
        if (!card) return;
        const weights = window.weightsByEntryId[q.entry_id] || (window.weightsByEntryId[q.entry_id] = {});
        card.querySelectorAll('input[data-option]').forEach(inp => {
            const opt = inp.getAttribute('data-option');
            if (q.type === 'text' && !q.options.includes(opt)) return;
            const val = parseFloat(inp.value);
            weights[opt] = isNaN(val) ? 0 : Math.max(0, val);
        });
    });
}

function normalizeQuestionWeights(entryId) {
    const q = window.formMeta.questions.find(x => x.entry_id === entryId);
    if (!q) return;
    const keys = getQuestionKeys(q);
    if (!keys.length) return;
    const current = window.weightsByEntryId[entryId] || (window.weightsByEntryId[entryId] = {});
    const raw = keys.map(k => Math.max(0, parseFloat(current[k]) || 0));
    const balanced = balanceWeights(raw, 100);
    keys.forEach((k, i) => { current[k] = balanced[i]; });
}

window.selectStrategy = function(strategy) {
    window.weightsByEntryId = {};
    window.userEditedWeights = {};
    window.formMeta.questions.forEach(q => {
        const keys = getQuestionKeys(q);
        if (!keys.length) return;
        const vals = strategy === 'random' ? keys.map(() => Math.random()) : keys.map(() => 1);
        const balanced = balanceWeights(vals, 100);
        const optWeights = {};
        keys.forEach((k, i) => { optWeights[k] = balanced[i]; });
        window.weightsByEntryId[q.entry_id] = optWeights;
    });
    if (window.formMeta.form_title) document.getElementById('formMainTitle').innerText = window.formMeta.form_title;
    showPage(0);
    goToPage(2);
};

function handleOptionInputChange(input, isChange = false) {
    const card = input.closest('.question-card');
    if (!card) return;
    const entryId = card.dataset.entryId;
    if (!entryId) return;

    const opt = input.getAttribute('data-option');
    const inputs = Array.from(card.querySelectorAll('input[data-option]'));
    if (inputs.length <= 1) {
        if (inputs.length === 1) input.value = 100;
        updateQuestionStatusNote(card, entryId);
        snapshotWeightsFromCurrentPage();
        return;
    }

    let val = parseFloat(input.value);
    if (isNaN(val)) {
        if (!isChange) {
            updateQuestionStatusNote(card, entryId);
            return;
        }
        val = 0;
        input.value = 0;
    }
    if (val < 0) { val = 0; input.value = 0; }
    else if (val > 100) { val = 100; input.value = 100; }

    const stored = window.weightsByEntryId[entryId] || (window.weightsByEntryId[entryId] = {});

    if (window.adjustmentMode === 'manual') {
        stored[opt] = val;
        updateQuestionStatusNote(card, entryId);
        snapshotWeightsFromCurrentPage();
        return;
    }

    if (!window.userEditedWeights[entryId]) {
        window.userEditedWeights[entryId] = new Set();
    }
    window.userEditedWeights[entryId].add(opt);
    stored[opt] = val;

    const editedSet = window.userEditedWeights[entryId];
    const editedInputs = inputs.filter(i => editedSet.has(i.getAttribute('data-option')));
    const untouchedInputs = inputs.filter(i => !editedSet.has(i.getAttribute('data-option')));

    const sumEdited = round2(editedInputs.reduce((sum, inp) => sum + (parseFloat(inp.value) || 0), 0));
    const remainingTarget = round2(100 - sumEdited);

    if (untouchedInputs.length > 0) {
        if (remainingTarget >= 0) {
            const untouchedVals = untouchedInputs.map(i => Math.max(0, parseFloat(i.value) || 0));
            const balanced = balanceWeights(untouchedVals, remainingTarget);
            untouchedInputs.forEach((inp, idx) => {
                inp.value = balanced[idx];
                stored[inp.getAttribute('data-option')] = balanced[idx];
            });
        } else {
            untouchedInputs.forEach(inp => {
                inp.value = 0;
                stored[inp.getAttribute('data-option')] = 0;
            });
        }
    } else {
        inputs.forEach(inp => {
            stored[inp.getAttribute('data-option')] = parseFloat(inp.value) || 0;
        });
    }

    updateQuestionStatusNote(card, entryId);
    snapshotWeightsFromCurrentPage();
}

function defaultWeight(eid, opt, count) {
    const stored = window.weightsByEntryId[eid];
    return (stored && stored[opt] !== undefined) ? stored[opt] : (count ? round2(100 / count) : 0);
}

window.showPage = function(index) {
    snapshotWeightsFromCurrentPage();
    window.currentPageIndex = index;
    renderQuestions(window.formPages[index] || []);
    document.getElementById('pageIndicator').innerText = `Page ${index + 1} of ${window.formPages.length}`;
    document.getElementById('prevPage').disabled = index <= 0;
    document.getElementById('nextPage').disabled = index >= window.formPages.length - 1;
    const finalBtn = document.getElementById('moveToAutomationBtn');
    if (finalBtn) finalBtn.parentElement.style.display = (index === window.formPages.length - 1) ? 'block' : 'none';
    if (window.formMeta.form_title) document.getElementById('formMainTitle').innerText = window.formMeta.form_title;
};

function renderQuestions(questions) {
    const container = document.getElementById('questionsContainer');
    container.innerHTML = '';
    questions.forEach(q => {
        const card = document.createElement('div');
        card.className = 'question-card';
        card.dataset.entryId = q.entry_id;
        const reqBadge = q.required 
            ? `<span class="req-badge badge-req">Required</span>` 
            : `<span class="req-badge badge-not-req">Optional</span>`;
        card.innerHTML = `<div class="question-header"><div><span class="question-type-tag">${q.type_name || 'Question'}</span><div class="question-title">${q.text}</div></div>${reqBadge}</div><div class="options-grid"></div><div class="weight-status-note" data-note-for="${q.entry_id}"></div>`;
        const grid = card.querySelector('.options-grid');

        if (q.type === 'linear' || q.type === 'rating') {
            const min = typeof q.min === 'number' ? q.min : 1;
            const max = typeof q.max === 'number' ? q.max : 5;
            const count = max - min + 1;
            for (let v = min; v <= max; v++) {
                let lbl = String(v);
                if (q.type === 'rating') {
                    lbl = `★ ${v}`;
                } else {
                    if (v === min && q.left_label) lbl = `${q.left_label} (${v})`;
                    if (v === max && q.right_label) lbl = `${q.right_label} (${v})`;
                }
                grid.insertAdjacentHTML('beforeend', `<div class="option-item"><span>${lbl}</span><div class="option-percent"><input type="number" step="any" value="${defaultWeight(q.entry_id, String(v), count)}" min="0" max="100" data-option="${v}"><span>%</span></div></div>`);
            }
        } else {
            (q.options || []).forEach(opt => {
                const lbl = formatOptionLabel(opt);
                const isCustom = q.type === 'text' || q.type === 'time' || q.type === 'date';
                const delBtn = isCustom ? `<button class="del-opt-btn" onclick="removeResponse('${q.entry_id}', '${opt.replace(/'/g, "\\'")}')"><i class="bi bi-x-circle"></i></button>` : '';
                grid.insertAdjacentHTML('beforeend', `<div class="option-item"><span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${lbl}">${lbl}</span><div class="option-percent"><input type="number" step="any" value="${defaultWeight(q.entry_id, opt, q.options.length)}" min="0" max="100" data-option="${opt}"><span>%</span>${delBtn}</div></div>`);
            });
            if (q.type === 'text' || q.type === 'time' || q.type === 'date') {
                const btn = document.createElement('button');
                btn.className = 'btn-dashed';
                btn.innerHTML = '+ Add Response';
                btn.onclick = () => openAddResponseModal(q.entry_id, q.type === 'time' ? 'time' : (q.type === 'date' ? 'date' : 'text'));
                card.appendChild(btn);
            }
        }

        // Bottom Equalize Weights Button
        const eqBtn = document.createElement('button');
        eqBtn.type = 'button';
        eqBtn.className = 'btn-equalize-weights';
        eqBtn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> Equalize Weights';
        eqBtn.onclick = () => resetQuestionWeights(q.entry_id);
        card.appendChild(eqBtn);

        container.appendChild(card);
        updateQuestionStatusNote(card, q.entry_id);
    });
}

function openAddResponseModal(eid, defaultType = 'text') {
    window.currentAddResponseEntryId = eid;
    ['staticTextValue', 'dateRangeStart', 'dateRangeEnd', 'numberRangeMin', 'numberRangeMax'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const sTime = document.getElementById('timeRangeStart');
    const eTime = document.getElementById('timeRangeEnd');
    if (sTime) sTime.value = '09:00';
    if (eTime) eTime.value = '17:00';
    document.getElementById('addResponseError').style.display = 'none';
    setType(defaultType);
    document.getElementById('addResponseModal').classList.add('active');
}

function setType(type) {
    window.currentAddResponseType = type;
    document.querySelectorAll('.type-select-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
    document.getElementById('staticTextSettings').style.display = type === 'text' ? 'block' : 'none';
    document.getElementById('dateRangeSettings').style.display = type === 'date' ? 'block' : 'none';
    document.getElementById('timeRangeSettings').style.display = type === 'time' ? 'block' : 'none';
    document.getElementById('numberRangeSettings').style.display = type === 'number' ? 'block' : 'none';
}

document.querySelectorAll('.type-select-btn').forEach(btn => btn.onclick = () => setType(btn.dataset.type));
document.getElementById('cancelAddResponseBtn').onclick = () => document.getElementById('addResponseModal').classList.remove('active');
document.getElementById('infoBtn').onclick = () => document.getElementById('infoModal').classList.add('active');
document.getElementById('closeModal').onclick = () => document.getElementById('infoModal').classList.remove('active');

document.getElementById('confirmAddResponseBtn').onclick = () => {
    const type = window.currentAddResponseType, errDiv = document.getElementById('addResponseError');
    errDiv.style.display = 'none';
    let opt = '';
    if (type === 'text') {
        opt = document.getElementById('staticTextValue').value.trim();
        if (!opt) { errDiv.innerText = 'Please enter text.'; errDiv.style.display = 'block'; return; }
    } else if (type === 'date') {
        const [s, e] = [document.getElementById('dateRangeStart').value, document.getElementById('dateRangeEnd').value];
        if (!s || !e) { errDiv.innerText = 'Please select start and end dates.'; errDiv.style.display = 'block'; return; }
        opt = `__GEN_DATE__|${s}|${e}`;
    } else if (type === 'time') {
        const [s, e] = [document.getElementById('timeRangeStart').value, document.getElementById('timeRangeEnd').value];
        if (!s || !e) { errDiv.innerText = 'Please select start and end times.'; errDiv.style.display = 'block'; return; }
        opt = `__GEN_TIME__|${s}|${e}`;
    } else if (type === 'number') {
        const [min, max] = [document.getElementById('numberRangeMin').value, document.getElementById('numberRangeMax').value];
        if (!min || !max || parseFloat(min) > parseFloat(max)) {
            errDiv.innerText = 'Please enter valid min and max values.'; errDiv.style.display = 'block'; return;
        }
        opt = `__GEN_NUM__|${min}|${max}`;
    }

    const q = window.formMeta.questions.find(x => x.entry_id === window.currentAddResponseEntryId);
    if (q && !q.options.includes(opt)) {
        q.options.push(opt);
        snapshotWeightsFromCurrentPage();
        (window.weightsByEntryId[q.entry_id] || (window.weightsByEntryId[q.entry_id] = {}))[opt] = 0;
        normalizeQuestionWeights(q.entry_id);
        showPage(window.currentPageIndex);
    }
    document.getElementById('addResponseModal').classList.remove('active');
};

window.removeResponse = function(eid, opt) {
    const q = window.formMeta.questions.find(x => x.entry_id === eid);
    if (q && (q.type === 'text' || q.type === 'time' || q.type === 'date')) {
        snapshotWeightsFromCurrentPage();
        q.options = q.options.filter(x => x !== opt);
        if (window.weightsByEntryId[eid]) delete window.weightsByEntryId[eid][opt];
        normalizeQuestionWeights(eid);
        showPage(window.currentPageIndex);
    }
};

document.getElementById('parseBtn').onclick = async () => {
    const url = document.getElementById('formUrl').value.trim();
    if (!url) return showError('Please enter a form URL.');
    showLoading(true); hideError(); hideWarning();
    window.formMeta = { questions: [], action_url: '', hidden_fields: {} };
    window.formPages = []; window.weightsByEntryId = {};
    document.getElementById('questionsContainer').innerHTML = '';

    try {
        await streamNDJSON('/parse', { form_url: url }, part => {
            if (part.type === 'metadata') {
                if (part.requires_signin) return showWarning('This form requires Google sign-in.');
                if (part.is_closed) return showWarning('This form is closed.');
                Object.assign(window.formMeta, part);
                window.formMeta.form_url = part.form_url || url;
                if (part.form_title) document.getElementById('formMainTitle').innerText = part.form_title;
            } else if (part.type === 'questions') {
                window.formMeta.questions.push(...part.data);
                window.formPages.push(part.data);
                if (window.formPages.length === 1) goToPage(1);
            } else if (part.type === 'error') {
                showError(part.message);
            }
        });
    } catch (err) {
        showError('Network error: ' + err.message);
    } finally {
        showLoading(false);
    }
};

document.getElementById('fillFormBtn').onclick = async () => {
    const num = parseInt(document.getElementById('numResponses').value);
    if (isNaN(num) || num < 1) return showError('Enter a valid number of responses.');

    snapshotWeightsFromCurrentPage();
    window.formMeta.questions.forEach(q => normalizeQuestionWeights(q.entry_id));

    document.getElementById('inputPhase').style.display = 'none';
    document.getElementById('progressPhase').style.display = 'block';

    const hiddenFields = { ...(window.formMeta.hidden_fields || {}) };
    if (window.formPages.length > 0) hiddenFields.pageHistory = window.formPages.map((_, i) => i).join(',');

    try {
        await streamNDJSON('/generate', {
            num_responses: num,
            weights: window.weightsByEntryId,
            questions: window.formMeta.questions,
            hidden_fields: hiddenFields,
            action_url: window.formMeta.action_url,
            form_url: document.getElementById('formUrl').value.trim()
        }, part => {
            if (part.type === 'progress') {
                document.getElementById('progressBar').style.width = `${(part.current / part.total) * 100}%`;
                document.getElementById('progressText').innerText = `Success: ${part.successful} / Failed: ${part.total - part.successful}`;
            } else if (part.type === 'complete') {
                document.getElementById('progressPhase').style.display = 'none';
                document.getElementById('resultPhase').style.display = 'block';
                document.getElementById('summaryContent').innerText = part.summary;
                renderDashboard(part);
                document.getElementById('downloadResponsesBtn').onclick = () => location.href = `/download/${part.job_id}?type=responses`;
                document.getElementById('downloadStatsBtn').onclick = () => location.href = `/download/${part.job_id}?type=stats`;
            }
        });
    } catch (err) {
        showError('Generation error: ' + err.message);
        document.getElementById('inputPhase').style.display = 'block';
        document.getElementById('progressPhase').style.display = 'none';
    }
};

function renderDashboard(part) {
    const globalCanvas = document.getElementById('globalStatsChart');
    const container = document.getElementById('dashboardContainer');
    container.innerHTML = '';
    const old = Chart.getChart(globalCanvas);
    if (old) old.destroy();

    new Chart(globalCanvas, {
        type: 'doughnut',
        data: {
            labels: ['Successful', 'Failed'],
            datasets: [{ data: [part.successful, part.total - part.successful], backgroundColor: ['#28a745', '#dc3545'], borderWidth: 0 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'right', labels: { color: '#a0a0a0' } }, title: { display: true, text: 'Total Automations', color: '#fff' } }
        }
    });

    const bgColors = ['#007bff','#28a745','#dc3545','#ffc107','#17a2b8','#6610f2','#e83e8c','#fd7e14','#20c997','#6c757d','#a29bfe','#55efc4','#ffeaa7','#fab1a0','#ff7675'];

    part.chart_data.forEach(q => {
        const card = document.createElement('div');
        card.className = 'chart-card';
        card.innerHTML = `<h3 style="margin-bottom:16px; font-size:14px; color:var(--on-surface);">${q.question}</h3><div style="position:relative; height:200px; width:100%;"><canvas></canvas></div>`;
        container.appendChild(card);
        const isPie = q.labels.length <= 4;
        new Chart(card.querySelector('canvas'), {
            type: isPie ? 'pie' : 'bar',
            data: {
                labels: q.labels,
                datasets: [{ label: 'Responses', data: q.counts, backgroundColor: bgColors.slice(0, q.labels.length), borderWidth: 0 }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: isPie, position: 'right', labels: { color: '#a0a0a0', font: { size: 10 } } } },
                scales: isPie ? {} : { y: { beginAtZero: true, grid: { color: '#333' }, ticks: { color: '#a0a0a0' } }, x: { grid: { display: false }, ticks: { color: '#a0a0a0', maxRotation: 45, minRotation: 45 } } }
            }
        });
    });
}

function generateFormSchemaJson() {
    return {
        form_title: window.formMeta.form_title || 'Google Form',
        form_description: window.formMeta.form_description || '',
        form_url: window.formMeta.form_url || document.getElementById('formUrl').value.trim(),
        action_url: window.formMeta.action_url || '',
        total_questions: (window.formMeta.questions || []).length,
        total_pages: (window.formPages && window.formPages.length) ? window.formPages.length : 1,
        questions: (window.formMeta.questions || []).map((q, idx) => {
            const item = {
                serial_number: idx + 1,
                label: q.label || q.text || '',
                entry: q.entry || q.entry_id || '',
                type: q.type_name || (q.type === 'linear' ? 'Linear scale' : (q.type === 'rating' ? 'Rating' : (q.type === 'checkbox' ? 'Checkboxes' : (q.type === 'radio' ? 'Multiple choice' : 'Short answer')))),
                required: !!q.required,
                description: q.description || '',
                page: (q.page || 0) + 1
            };
            if (q.options && q.options.length) item.options = q.options.map(formatOptionLabel);
            else if (q.type === 'linear' || q.type === 'rating') item.scale = { min: q.min, max: q.max, left_label: q.left_label || '', right_label: q.right_label || '' };
            return item;
        })
    };
}

function downloadFormSchemaJson() {
    const schema = generateFormSchemaJson();
    if (!schema.questions || !schema.questions.length) return showError('No form questions found to export. Please parse a form first.');
    const filename = `${(schema.form_title || 'form_schema').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()}_schema.json`;
    const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([JSON.stringify(schema, null, 2)], { type: 'application/json' })),
        download: filename
    });
    document.body.appendChild(a); a.click(); a.remove();
}

['downloadSchemaConfigBtn', 'downloadSchemaInputBtn', 'downloadSchemaResultBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.onclick = downloadFormSchemaJson;
});

document.getElementById('prevPage').onclick = () => window.currentPageIndex > 0 && showPage(window.currentPageIndex - 1);
document.getElementById('nextPage').onclick = () => window.currentPageIndex < window.formPages.length - 1 && showPage(window.currentPageIndex + 1);

const qContainer = document.getElementById('questionsContainer');
qContainer.addEventListener('input', e => { if (e.target.matches('input[data-option]')) handleOptionInputChange(e.target, false); });
qContainer.addEventListener('change', e => { if (e.target.matches('input[data-option]')) handleOptionInputChange(e.target, true); });
qContainer.addEventListener('blur', e => { if (e.target.matches('input[data-option]')) handleOptionInputChange(e.target, true); }, true);