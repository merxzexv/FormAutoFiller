// script.js - Application Logic, State Management, and API

window.resetApp = function() {
    window.location.reload();
};

window.roundToTwo = function(num) {
    return Math.round((num + Number.EPSILON) * 100) / 100;
};

window.selectStrategy = function(strategy) {
    window.weightsByEntryId = {};
    const questions = window.formMeta.questions;

    questions.forEach(q => {
        const entryId = q.entry_id;
        const optWeights = {};

        let keys = [];
        if (q.type === 'radio' || q.type === 'checkbox' || q.type === 'text') {
            keys = (q.options || []).slice();
        } else if (q.type === 'linear') {
            for (let v = q.min; v <= q.max; v++) keys.push(String(v));
        }

        const count = keys.length;
        if (count === 0) return;

        if (strategy === 'random') {
            let raws = keys.map(() => Math.random());
            const total = raws.reduce((a, b) => a + b, 0);
            let percents = raws.map(r => window.roundToTwo((r / total) * 100));
            let diff = window.roundToTwo(100 - percents.reduce((a, b) => a + b, 0));
            percents[0] = window.roundToTwo(percents[0] + diff);
            keys.forEach((k, i) => { optWeights[k] = percents[i]; });
        } else {
            let base = window.roundToTwo(100 / count);
            let percents = keys.map(() => base);
            let diff = window.roundToTwo(100 - percents.reduce((a, b) => a + b, 0));
            percents[0] = window.roundToTwo(percents[0] + diff);
            keys.forEach((k, i) => { optWeights[k] = percents[i]; });
        }

        window.weightsByEntryId[entryId] = optWeights;
    });

    const titleEl = document.getElementById('formMainTitle');
    if (titleEl && window.formMeta && window.formMeta.form_title) {
        titleEl.innerText = window.formMeta.form_title;
    }

    if (typeof showPage === 'function') showPage(0);
    if (typeof goToPage === 'function') goToPage(2);
};

document.getElementById('parseBtn').addEventListener('click', async () => {
    const url = document.getElementById('formUrl').value.trim();
    if (!url) {
        showError('Please enter a form URL.');
        return;
    }

    showLoading(true);
    hideError();
    hideWarning();
    
    window.formMeta = { questions: [], action_url: '', hidden_fields: {} };
    window.formPages = [];
    window.currentPageIndex = 0;
    window.weightsByEntryId = {};
    document.getElementById('questionsContainer').innerHTML = '';
    
    try {
        const response = await fetch('/parse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ form_url: url })
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const part = JSON.parse(trimmed);
                    handleParseChunk(part);
                } catch (e) {
                    console.error('Failed to parse line:', trimmed);
                }
            }
        }
    } catch (err) {
        showError('Network error: ' + err.message);
    } finally {
        showLoading(false);
    }
});

window.handleParseChunk = function(part) {
    if (part.type === 'metadata') {
        if (part.requires_signin) {
            showWarning('This form requires Google sign-in.');
            return;
        }
        if (part.is_closed) {
            showWarning('This form is closed.');
            return;
        }
        window.formMeta.action_url = part.action_url;
        window.formMeta.hidden_fields = part.hidden_fields;
        window.formMeta.form_url = part.form_url || document.getElementById('formUrl').value.trim();
        window.formMeta.form_title = part.form_title || 'Google Form';
        window.formMeta.form_description = part.form_description || '';

        const titleEl = document.getElementById('formMainTitle');
        if (titleEl && part.form_title) {
            titleEl.innerText = part.form_title;
        }
    } else if (part.type === 'questions') {
        window.formMeta.questions.push(...part.data);
        window.formPages.push(part.data);
        
        if (window.formPages.length === 1) {
            goToPage(1); 
        }
        updatePaginationButtons();
    } else if (part.type === 'error') {
        showError(part.message);
    }
};

window.snapshotWeightsFromCurrentPage = function() {
    const questions = window.formPages[window.currentPageIndex];
    if (!questions) return;
    for (const q of questions) {
        const card = document.querySelector(`.question-card[data-entry-id="${q.entry_id}"]`);
        if (!card) continue;

        const inputs = card.querySelectorAll('input[data-option]');
        const optWeights = { ...(window.weightsByEntryId[q.entry_id] || {}) };
        
        if (q.type === 'text') {
            for (const k in optWeights) {
                if (!q.options.includes(k)) delete optWeights[k];
            }
        }

        inputs.forEach(inp => {
            const opt = inp.getAttribute('data-option');
            if (q.type === 'text' && !q.options.includes(opt)) return;
            
            let weight = parseFloat(inp.value);
            if (isNaN(weight)) weight = 1;
            if (weight < 0) weight = 0;
            optWeights[opt] = weight;
        });
        window.weightsByEntryId[q.entry_id] = optWeights;
    }
};

window.defaultWeightForOption = function(entryId, opt, count) {
    const stored = window.weightsByEntryId[entryId];
    if (stored && Object.prototype.hasOwnProperty.call(stored, opt)) return stored[opt];
    return count ? window.roundToTwo(100 / count) : 0;
};

window.normalizeQuestionWeights = function(entryId) {
    const q = window.formMeta.questions.find(x => x.entry_id === entryId);
    if (!q) return;

    let keys = [];
    if (q.type === 'radio' || q.type === 'checkbox' || q.type === 'text') {
        keys = (q.options || []).slice();
    } else if (q.type === 'linear') {
        for (let v = q.min; v <= q.max; v++) keys.push(String(v));
    }
    if (keys.length === 0) return;

    if (!window.weightsByEntryId[entryId]) {
        window.weightsByEntryId[entryId] = {};
    }
    const currentWeights = window.weightsByEntryId[entryId];

    let currentVals = keys.map(k => Math.max(0, parseFloat(currentWeights[k]) || 0));
    let total = currentVals.reduce((a, b) => a + b, 0);

    let newWeights = [];
    if (total > 0.0001) {
        newWeights = currentVals.map(v => (v / total) * 100);
    } else {
        newWeights = keys.map(() => 100 / keys.length);
    }

    let rounded = newWeights.map(w => window.roundToTwo(w));
    let diff = window.roundToTwo(100 - rounded.reduce((a, b) => a + b, 0));
    if (diff !== 0 && rounded.length > 0) {
        let maxIdx = 0;
        for (let i = 1; i < newWeights.length; i++) {
            if (newWeights[i] > newWeights[maxIdx]) maxIdx = i;
        }
        rounded[maxIdx] = window.roundToTwo(rounded[maxIdx] + diff);
    }

    keys.forEach((k, i) => {
        currentWeights[k] = rounded[i];
    });
};

window.handleOptionInputChange = function(input) {
    const card = input.closest('.question-card');
    if (!card) return;
    const inputs = Array.from(card.querySelectorAll('input[data-option]'));
    if (inputs.length <= 1) {
        if (inputs.length === 1) input.value = 100;
        if (typeof snapshotWeightsFromCurrentPage === 'function') snapshotWeightsFromCurrentPage();
        return;
    }

    let val = parseFloat(input.value);
    if (isNaN(val)) return;

    if (val < 0) {
        val = 0;
        input.value = 0;
    } else if (val > 100) {
        val = 100;
        input.value = 100;
    }

    const remainder = Math.max(0, 100 - val);
    const otherInputs = inputs.filter(inp => inp !== input);
    const otherVals = otherInputs.map(inp => Math.max(0, parseFloat(inp.value) || 0));
    const sumOther = otherVals.reduce((a, b) => a + b, 0);

    let fractions;
    if (sumOther > 0.0001) {
        fractions = otherVals.map(v => v / sumOther);
    } else {
        fractions = otherVals.map(() => 1 / otherInputs.length);
    }

    let targets = fractions.map(f => f * remainder);
    let rounded = targets.map(t => window.roundToTwo(t));
    let sumRounded = rounded.reduce((a, b) => a + b, 0);
    let diff = window.roundToTwo(remainder - sumRounded);

    if (diff !== 0 && rounded.length > 0) {
        let maxIdx = 0;
        for (let i = 1; i < targets.length; i++) {
            if (targets[i] > targets[maxIdx]) maxIdx = i;
        }
        rounded[maxIdx] = window.roundToTwo(rounded[maxIdx] + diff);
    }

    otherInputs.forEach((inp, idx) => {
        inp.value = rounded[idx];
    });

    if (typeof snapshotWeightsFromCurrentPage === 'function') {
        snapshotWeightsFromCurrentPage();
    }
};

window.finalizeOptionInput = function(input) {
    let val = parseFloat(input.value);
    if (isNaN(val) || val < 0) {
        input.value = 0;
    } else if (val > 100) {
        input.value = 100;
    }
    window.handleOptionInputChange(input);
};

window.removeResponse = function(entryId, opt) {
    const q = window.formMeta.questions.find(x => x.entry_id === entryId);
    if (q && q.type === 'text') {
        snapshotWeightsFromCurrentPage();
        q.options = q.options.filter(x => x !== opt);
        if (window.weightsByEntryId[entryId]) {
            delete window.weightsByEntryId[entryId][opt];
        }
        window.normalizeQuestionWeights(entryId);
        showPage(window.currentPageIndex);
    }
};

document.getElementById('fillFormBtn').addEventListener('click', async () => {
    const numResponses = parseInt(document.getElementById('numResponses').value);
    if (isNaN(numResponses) || numResponses < 1) {
        showError('Enter a valid number of responses.');
        return;
    }

    snapshotWeightsFromCurrentPage();

    // Automatically normalize all question option weights to ensure they sum to exactly 100%
    const questions = window.formMeta.questions;
    for (const q of questions) {
        window.normalizeQuestionWeights(q.entry_id);
    }

    document.getElementById('inputPhase').style.display = 'none';
    document.getElementById('progressPhase').style.display = 'block';

    const weights = { ...window.weightsByEntryId };
    for (const q of questions) {
        const entryId = q.entry_id;
        const card = document.querySelector(`.question-card[data-entry-id="${entryId}"]`);
        const optWeights = { ...(weights[entryId] || {}) };
        if (card) {
            const inputs = card.querySelectorAll('input[data-option]');
            inputs.forEach(inp => {
                const opt = inp.getAttribute('data-option');
                let weight = parseFloat(inp.value);
                if (isNaN(weight)) weight = 1;
                optWeights[opt] = weight < 0 ? 0 : weight;
            });
        }
        weights[entryId] = optWeights;
    }

    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');

    const hiddenFields = { ...(window.formMeta.hidden_fields || {}) };
    if (window.formPages && window.formPages.length > 0) {
        hiddenFields.pageHistory = Array.from({ length: window.formPages.length }, (_, i) => i).join(',');
    }

    try {
        const response = await fetch('/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                num_responses: numResponses,
                weights: weights,
                questions: window.formMeta.questions,
                hidden_fields: hiddenFields,
                action_url: window.formMeta.action_url,
                form_url: document.getElementById('formUrl').value.trim()
            })
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const part = JSON.parse(trimmed);
                    if (part.type === 'progress') {
                        const perc = (part.current / part.total) * 100;
                        progressBar.style.width = `${perc}%`;
                        progressText.innerText = `Success: ${part.successful} / Failed: ${part.total - part.successful}`;
                    } else if (part.type === 'complete') {
                        document.getElementById('progressPhase').style.display = 'none';
                        document.getElementById('resultPhase').style.display = 'block';
                        document.getElementById('summaryContent').innerText = part.summary;
                        if (typeof window.renderDashboard === 'function') {
                            window.renderDashboard(part);
                        }
                        
                        document.getElementById('downloadResponsesBtn').onclick = () => {
                            window.location.href = `/download/${part.job_id}?type=responses`;
                        };
                        document.getElementById('downloadStatsBtn').onclick = () => {
                            window.location.href = `/download/${part.job_id}?type=stats`;
                        };
                        const schemaResultBtn = document.getElementById('downloadSchemaResultBtn');
                        if (schemaResultBtn) {
                            schemaResultBtn.onclick = () => {
                                window.downloadFormSchemaJson();
                            };
                        }
                    }
                } catch (e) {}
            }
        }
    } catch (err) {
        showError('Generation error: ' + err.message);
        document.getElementById('inputPhase').style.display = 'block';
        document.getElementById('progressPhase').style.display = 'none';
    }
});

window.generateFormSchemaJson = function() {
    const questions = window.formMeta.questions || [];
    const formattedQuestions = questions.map((q, idx) => {
        const item = {
            serial_number: idx + 1,
            label: q.label || q.text || '',
            entry: q.entry || q.entry_id || '',
            type: q.type_name || (q.type === 'linear' ? 'Linear scale' : (q.type === 'checkbox' ? 'Checkboxes' : (q.type === 'radio' ? 'Multiple choice' : 'Short answer'))),
            required: typeof q.required === 'boolean' ? q.required : false,
            description: q.description || ''
        };

        if (q.options && q.options.length > 0) {
            item.options = q.options.map(opt => window.formatOptionLabel ? window.formatOptionLabel(opt) : opt);
        } else if (q.type === 'linear') {
            item.scale = {
                min: q.min,
                max: q.max,
                left_label: q.left_label || '',
                right_label: q.right_label || ''
            };
        }

        item.page = (typeof q.page === 'number' ? q.page : 0) + 1;
        return item;
    });

    return {
        form_title: window.formMeta.form_title || 'Google Form',
        form_description: window.formMeta.form_description || '',
        form_url: window.formMeta.form_url || document.getElementById('formUrl').value.trim(),
        action_url: window.formMeta.action_url || '',
        total_questions: formattedQuestions.length,
        total_pages: (window.formPages && window.formPages.length) ? window.formPages.length : 1,
        questions: formattedQuestions
    };
};

window.downloadFormSchemaJson = function() {
    const schemaData = window.generateFormSchemaJson();
    if (!schemaData.questions || schemaData.questions.length === 0) {
        showError('No form questions found to export. Please parse a form first.');
        return;
    }
    const safeTitle = (schemaData.form_title || 'form_schema').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const filename = `${safeTitle || 'form'}_schema.json`;

    const blob = new Blob([JSON.stringify(schemaData, null, 2)], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

// Bind schema download buttons on DOM ready or click
['downloadSchemaConfigBtn', 'downloadSchemaInputBtn', 'downloadSchemaResultBtn'].forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.addEventListener('click', () => {
            window.downloadFormSchemaJson();
        });
    }
});