// Navigation
window.goToPage = function(index) {
    const container = document.getElementById('pageContainer');
    container.style.transform = `translateX(-${index * 25}%)`;
    if (index === 2) resetExecutionPhase(); // Reset when going back to config
};

function resetExecutionPhase() {
    document.getElementById('inputPhase').style.display = 'block';
    document.getElementById('progressPhase').style.display = 'none';
    document.getElementById('resultPhase').style.display = 'none';
    document.getElementById('progressBar').style.width = '0%';
}

window.resetApp = function() {
    window.location.reload();
};

window.selectStrategy = function(strategy) {
    window.weightsByEntryId = {};
    const questions = window.formMeta.questions;

    questions.forEach(q => {
        const entryId = q.entry_id;
        const optWeights = {};

        let keys = [];
        if (q.type === 'radio' || q.type === 'checkbox') {
            keys = q.options.slice();
        } else if (q.type === 'linear') {
            for (let v = q.min; v <= q.max; v++) keys.push(String(v));
        }

        const count = keys.length;
        if (strategy === 'random') {
            // Generate random values summing to 100
            let raws = keys.map(() => Math.random());
            const total = raws.reduce((a, b) => a + b, 0);
            let percents = raws.map(r => Math.floor((r / total) * 100));
            // Fix rounding so they sum to exactly 100
            let diff = 100 - percents.reduce((a, b) => a + b, 0);
            percents[0] += diff;
            keys.forEach((k, i) => { optWeights[k] = percents[i]; });
        } else {
            // Equal split
            const base = Math.floor(100 / count);
            const rem = 100 - base * count;
            keys.forEach((k, i) => { optWeights[k] = base + (i === 0 ? rem : 0); });
        }

        window.weightsByEntryId[entryId] = optWeights;
    });

    showPage(0);
    goToPage(2);
};

// Modal Logic
document.getElementById('infoBtn').onclick = () => document.getElementById('infoModal').classList.add('active');
document.getElementById('closeModal').onclick = () => document.getElementById('infoModal').classList.remove('active');

// Parsing Logic
document.getElementById('parseBtn').addEventListener('click', async () => {
    const url = document.getElementById('formUrl').value.trim();
    if (!url) {
        showError('Please enter a form URL.');
        return;
    }

    showLoading(true);
    hideError();
    hideWarning();
    
    // Reset global state
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

function handleParseChunk(part) {
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
    } else if (part.type === 'questions') {
        window.formMeta.questions.push(...part.data);
        window.formPages.push(part.data);
        
        if (window.formPages.length === 1) {
            goToPage(1); // Move to Selection screen
        }
        updatePaginationButtons();
    } else if (part.type === 'error') {
        showError(part.message);
    }
}

function showPage(index) {
    snapshotWeightsFromCurrentPage();
    window.currentPageIndex = index;
    const questions = window.formPages[index];
    renderAdditionalQuestions(questions);
    
    document.getElementById('pageIndicator').innerText = `Page ${index + 1} of ${window.formPages.length}`;
    updatePaginationButtons();
}

function snapshotWeightsFromCurrentPage() {
    const questions = window.formPages[window.currentPageIndex];
    if (!questions) return;
    for (const q of questions) {
        const card = document.querySelector(`.question-card[data-entry-id="${q.entry_id}"]`);
        if (!card) continue;
        const inputs = card.querySelectorAll('input[data-option]');
        const optWeights = { ...(window.weightsByEntryId[q.entry_id] || {}) };
        inputs.forEach(inp => {
            const opt = inp.getAttribute('data-option');
            let weight = parseFloat(inp.value);
            if (isNaN(weight)) weight = 1;
            if (weight < 0) weight = 0;
            optWeights[opt] = weight;
        });
        window.weightsByEntryId[q.entry_id] = optWeights;
    }
}

function updatePaginationButtons() {
    const prevBtn = document.getElementById('prevPage');
    const nextBtn = document.getElementById('nextPage');
    const finalBtn = document.getElementById('moveToAutomationBtn');
    
    if (prevBtn && nextBtn) {
        prevBtn.disabled = window.currentPageIndex <= 0;
        nextBtn.disabled = window.currentPageIndex >= window.formPages.length - 1;
    }

    if (finalBtn) {
        finalBtn.parentElement.style.display = (window.currentPageIndex === window.formPages.length - 1) ? 'block' : 'none';
    }
}

document.getElementById('prevPage').addEventListener('click', () => {
    if (window.currentPageIndex > 0) showPage(window.currentPageIndex - 1);
});

document.getElementById('nextPage').addEventListener('click', () => {
    if (window.currentPageIndex < window.formPages.length - 1) showPage(window.currentPageIndex + 1);
});

function renderAdditionalQuestions(questions) {
    const container = document.getElementById('questionsContainer');
    container.innerHTML = '';
    questions.forEach(q => {
        const card = document.createElement('div');
        card.className = 'question-card';
        card.dataset.entryId = q.entry_id;
        card.innerHTML = `<div class="question-text" style="font-weight:600; margin-bottom:16px;">${q.text}</div><div class="options-grid"></div>`;
        
        const grid = card.querySelector('.options-grid');
        if (q.type === 'radio' || q.type === 'checkbox') {
            q.options.forEach(opt => {
                const w = defaultWeightForOption(q.entry_id, opt, q.options.length);
                const optDiv = document.createElement('div');
                optDiv.className = 'option-item';
                optDiv.innerHTML = `<span>${opt}</span><div class="option-percent"><input type="number" value="${w}" min="0" max="100" data-option="${opt}"><span>%</span></div>`;
                grid.appendChild(optDiv);
            });
        } else if (q.type === 'linear') {
            const count = q.max - q.min + 1;
            for (let val = q.min; val <= q.max; val++) {
                let label = val;
                if (val === q.min && q.left_label) label = `${q.left_label} (${val})`;
                if (val === q.max && q.right_label) label = `${q.right_label} (${val})`;
                const w = defaultWeightForOption(q.entry_id, String(val), count);
                const optDiv = document.createElement('div');
                optDiv.className = 'option-item';
                optDiv.innerHTML = `<span>${label}</span><div class="option-percent"><input type="number" value="${w}" min="0" max="100" data-option="${val}"><span>%</span></div>`;
                grid.appendChild(optDiv);
            }
        }
        container.appendChild(card);
    });
}

function defaultWeightForOption(entryId, opt, count) {
    const stored = window.weightsByEntryId[entryId];
    if (stored && Object.prototype.hasOwnProperty.call(stored, opt)) return stored[opt];
    // Default: equal split summing to 100
    return count ? Math.floor(100 / count) : 0;
}

function validatePercentages() {
    const questions = window.formMeta.questions;
    const issues = [];
    for (const q of questions) {
        const card = document.querySelector(`.question-card[data-entry-id="${q.entry_id}"]`);
        if (!card) continue;
        const inputs = card.querySelectorAll('input[data-option]');
        let sum = 0;
        inputs.forEach(inp => { sum += parseFloat(inp.value) || 0; });
        if (Math.round(sum) !== 100) {
            issues.push(`"${q.text.slice(0, 40)}..." sums to ${sum}% (must be 100%).`);
        }
    }
    return issues;
}

// Automation
document.getElementById('fillFormBtn').addEventListener('click', async () => {
    const numResponses = parseInt(document.getElementById('numResponses').value);
    if (isNaN(numResponses) || numResponses < 1) {
        showError('Enter a valid number of responses.');
        return;
    }

    snapshotWeightsFromCurrentPage();

    // Validate percentages
    const issues = validatePercentages();
    if (issues.length > 0) {
        showError('Fix percentages before continuing:\n' + issues.join('\n'));
        return;
    }

    // Switch to Progress phase on same screen
    document.getElementById('inputPhase').style.display = 'none';
    document.getElementById('progressPhase').style.display = 'block';

    const weights = { ...window.weightsByEntryId };
    const questions = window.formMeta.questions;
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

    try {
        const response = await fetch('/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                num_responses: numResponses,
                weights: weights,
                questions: window.formMeta.questions,
                hidden_fields: window.formMeta.hidden_fields,
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
                        // Switch to Result phase
                        document.getElementById('progressPhase').style.display = 'none';
                        document.getElementById('resultPhase').style.display = 'block';
                        document.getElementById('summaryContent').innerText = part.summary;
                        
                        document.getElementById('downloadResponsesBtn').onclick = () => {
                            window.location.href = `/download/${part.job_id}?type=responses`;
                        };
                        document.getElementById('downloadStatsBtn').onclick = () => {
                            window.location.href = `/download/${part.job_id}?type=stats`;
                        };
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

function showLoading(show) {
    document.getElementById('loading').style.display = show ? 'block' : 'none';
    document.getElementById('parseBtn').disabled = show;
}

function showError(msg) {
    const errDiv = document.getElementById('error');
    errDiv.innerText = msg;
    errDiv.style.display = 'block';
}
function hideError() { document.getElementById('error').style.display = 'none'; }
function showWarning(msg) {
    const warnDiv = document.getElementById('signinWarning');
    warnDiv.innerText = msg;
    warnDiv.style.display = 'block';
}
function hideWarning() { document.getElementById('signinWarning').style.display = 'none'; }