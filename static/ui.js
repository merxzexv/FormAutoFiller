// ui.js - DOM Manipulation and UI Rendering

// Navigation
window.goToPage = function(index) {
    const container = document.getElementById('pageContainer');
    container.style.transform = `translateX(-${index * 25}%)`;
    if (index === 2) resetExecutionPhase(); // Reset when going back to config
};

window.resetExecutionPhase = function() {
    document.getElementById('inputPhase').style.display = 'block';
    document.getElementById('progressPhase').style.display = 'none';
    document.getElementById('resultPhase').style.display = 'none';
    document.getElementById('progressBar').style.width = '0%';
};

window.showPage = function(index) {
    if (typeof snapshotWeightsFromCurrentPage === 'function') snapshotWeightsFromCurrentPage();
    window.currentPageIndex = index;
    const questions = window.formPages[index];
    renderAdditionalQuestions(questions);
    
    document.getElementById('pageIndicator').innerText = `Page ${index + 1} of ${window.formPages.length}`;
    updatePaginationButtons();

    const titleEl = document.getElementById('formMainTitle');
    if (titleEl && window.formMeta && window.formMeta.form_title) {
        titleEl.innerText = window.formMeta.form_title;
    }
};

window.updatePaginationButtons = function() {
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
};

document.getElementById('prevPage').addEventListener('click', () => {
    if (window.currentPageIndex > 0) showPage(window.currentPageIndex - 1);
});

document.getElementById('nextPage').addEventListener('click', () => {
    if (window.currentPageIndex < window.formPages.length - 1) showPage(window.currentPageIndex + 1);
});

// Modal Logic
document.getElementById('infoBtn').onclick = () => document.getElementById('infoModal').classList.add('active');
document.getElementById('closeModal').onclick = () => document.getElementById('infoModal').classList.remove('active');

// Custom Add Response Modal Logic
window.currentAddResponseType = 'text';

document.querySelectorAll('.type-select-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.type-select-btn').forEach(b => {
            b.style.background = 'transparent';
            b.style.color = 'var(--on-surface)';
            b.style.border = '1px solid var(--border)';
            b.classList.remove('active');
        });
        
        const target = e.currentTarget;
        target.style.background = 'transparent';
        target.style.color = 'var(--on-surface)';
        target.style.border = '1px solid var(--primary)';
        target.classList.add('active');
        
        window.currentAddResponseType = target.dataset.type;
        
        document.querySelectorAll('.response-settings-group').forEach(el => el.style.display = 'none');
        if (window.currentAddResponseType === 'text') document.getElementById('staticTextSettings').style.display = 'block';
        if (window.currentAddResponseType === 'date') document.getElementById('dateRangeSettings').style.display = 'block';
        if (window.currentAddResponseType === 'number') document.getElementById('numberRangeSettings').style.display = 'block';
    });
});

document.getElementById('cancelAddResponseBtn').onclick = () => {
    document.getElementById('addResponseModal').classList.remove('active');
    document.getElementById('addResponseError').style.display = 'none';
};

document.getElementById('confirmAddResponseBtn').onclick = () => {
    const type = window.currentAddResponseType;
    const errDiv = document.getElementById('addResponseError');
    errDiv.style.display = 'none';
    
    let cleanOpt = '';
    
    if (type === 'text') {
        const val = document.getElementById('staticTextValue').value.trim();
        if (!val) { errDiv.innerText = 'Please enter text.'; errDiv.style.display = 'block'; return; }
        cleanOpt = val;
    } else if (type === 'date') {
        const start = document.getElementById('dateRangeStart').value;
        const end = document.getElementById('dateRangeEnd').value;
        if (!start || !end) { errDiv.innerText = 'Please select start and end dates.'; errDiv.style.display = 'block'; return; }
        cleanOpt = `__GEN_DATE__|${start}|${end}`;
    } else if (type === 'number') {
        const min = document.getElementById('numberRangeMin').value;
        const max = document.getElementById('numberRangeMax').value;
        if (!min || !max) { errDiv.innerText = 'Please enter min and max values.'; errDiv.style.display = 'block'; return; }
        if (parseFloat(min) > parseFloat(max)) { errDiv.innerText = 'Min cannot be greater than Max.'; errDiv.style.display = 'block'; return; }
        cleanOpt = `__GEN_NUM__|${min}|${max}`;
    }

    const entryId = window.currentAddResponseEntryId;
    const q = window.formMeta.questions.find(x => x.entry_id === entryId);
    if (q) {
        if (!q.options.includes(cleanOpt)) {
            q.options.push(cleanOpt);
            if (typeof snapshotWeightsFromCurrentPage === 'function') snapshotWeightsFromCurrentPage();
            if (!window.weightsByEntryId[q.entry_id]) window.weightsByEntryId[q.entry_id] = {};
            window.weightsByEntryId[q.entry_id][cleanOpt] = 0;
            if (typeof normalizeQuestionWeights === 'function') {
                normalizeQuestionWeights(q.entry_id);
            }
            showPage(window.currentPageIndex);
        }
    }
    document.getElementById('addResponseModal').classList.remove('active');
};

window.formatOptionLabel = function(opt) {
    if (opt.startsWith('__GEN_DATE__|')) {
        const parts = opt.split('|');
        return `Date Range: ${parts[1]} to ${parts[2]}`;
    }
    if (opt.startsWith('__GEN_NUM__|')) {
        const parts = opt.split('|');
        return `Number Range: ${parts[1]} to ${parts[2]}`;
    }
    return opt;
};

window.renderAdditionalQuestions = function(questions) {
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
                const displayW = typeof w === 'number' ? (typeof window.roundToTwo === 'function' ? window.roundToTwo(w) : Math.round(w * 100) / 100) : w;
                const optDiv = document.createElement('div');
                optDiv.className = 'option-item';
                optDiv.innerHTML = `<span>${opt}</span><div class="option-percent"><input type="number" step="any" value="${displayW}" min="0" max="100" data-option="${opt}"><span>%</span></div>`;
                grid.appendChild(optDiv);
            });
        } else if (q.type === 'text') {
            q.options.forEach(opt => {
                const w = defaultWeightForOption(q.entry_id, opt, q.options.length);
                const displayW = typeof w === 'number' ? (typeof window.roundToTwo === 'function' ? window.roundToTwo(w) : Math.round(w * 100) / 100) : w;
                const optDiv = document.createElement('div');
                optDiv.className = 'option-item';
                const label = formatOptionLabel(opt);
                optDiv.innerHTML = `<span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${label}">${label}</span><div class="option-percent"><input type="number" step="any" value="${displayW}" min="0" max="100" data-option="${opt}"><span>%</span><button style="margin-left:8px; cursor:pointer; background:transparent; border:none; color:#e74c3c; font-size:16px;" onclick="removeResponse('${q.entry_id}', '${opt.replace(/'/g, "\\'")}')"><i class="bi bi-x-circle"></i></button></div>`;
                grid.appendChild(optDiv);
            });

            const addBtn = document.createElement('button');
            addBtn.innerHTML = '+ Add Response';
            addBtn.style.marginTop = '12px';
            addBtn.style.background = 'transparent';
            addBtn.style.border = '1px dashed var(--border)';
            addBtn.style.color = 'var(--primary)';
            addBtn.style.padding = '8px 16px';
            addBtn.style.borderRadius = '8px';
            addBtn.style.cursor = 'pointer';
            addBtn.style.width = '100%';
            addBtn.onclick = () => {
                window.currentAddResponseEntryId = q.entry_id;
                document.getElementById('staticTextValue').value = '';
                document.getElementById('dateRangeStart').value = '';
                document.getElementById('dateRangeEnd').value = '';
                document.getElementById('numberRangeMin').value = '';
                document.getElementById('numberRangeMax').value = '';
                document.getElementById('addResponseError').style.display = 'none';
                
                window.currentAddResponseType = 'text';
                document.querySelectorAll('.response-settings-group').forEach(el => el.style.display = 'none');
                document.getElementById('staticTextSettings').style.display = 'block';
                
                document.querySelectorAll('.type-select-btn').forEach(b => {
                    b.style.background = 'transparent';
                    b.style.color = 'var(--on-surface)';
                    b.style.border = '1px solid var(--border)';
                    b.classList.remove('active');
                    if (b.dataset.type === 'text') {
                        b.style.background = 'transparent';
                        b.style.color = 'var(--on-surface)';
                        b.style.border = '1px solid var(--primary)';
                        b.classList.add('active');
                    }
                });

                document.getElementById('addResponseModal').classList.add('active');
            };
            card.appendChild(addBtn);
        } else if (q.type === 'linear') {
            const count = q.max - q.min + 1;
            for (let val = q.min; val <= q.max; val++) {
                let label = val;
                if (val === q.min && q.left_label) label = `${q.left_label} (${val})`;
                if (val === q.max && q.right_label) label = `${q.right_label} (${val})`;
                const w = defaultWeightForOption(q.entry_id, String(val), count);
                const displayW = typeof w === 'number' ? (typeof window.roundToTwo === 'function' ? window.roundToTwo(w) : Math.round(w * 100) / 100) : w;
                const optDiv = document.createElement('div');
                optDiv.className = 'option-item';
                optDiv.innerHTML = `<span>${label}</span><div class="option-percent"><input type="number" step="any" value="${displayW}" min="0" max="100" data-option="${val}"><span>%</span></div>`;
                grid.appendChild(optDiv);
            }
        }
        container.appendChild(card);
    });
};

const questionsContainer = document.getElementById('questionsContainer');
if (questionsContainer) {
    questionsContainer.addEventListener('input', (e) => {
        if (e.target.matches('input[data-option]')) {
            if (typeof handleOptionInputChange === 'function') {
                handleOptionInputChange(e.target);
            }
        }
    });

    questionsContainer.addEventListener('change', (e) => {
        if (e.target.matches('input[data-option]')) {
            if (typeof finalizeOptionInput === 'function') {
                finalizeOptionInput(e.target);
            }
        }
    });
}

// UI Feedback helpers
window.showLoading = function(show) {
    document.getElementById('loading').style.display = show ? 'block' : 'none';
    document.getElementById('parseBtn').disabled = show;
};

window.showError = function(msg) {
    const errDiv = document.getElementById('error');
    errDiv.innerText = msg;
    errDiv.style.display = 'block';
    
    // Auto hide after 6 seconds
    if (window.errorTimeout) clearTimeout(window.errorTimeout);
    window.errorTimeout = setTimeout(() => {
        hideError();
    }, 6000);
};
window.hideError = function() { document.getElementById('error').style.display = 'none'; };

window.showWarning = function(msg) {
    const warnDiv = document.getElementById('signinWarning');
    warnDiv.innerText = msg;
    warnDiv.style.display = 'block';
    
    // Auto hide after 6 seconds
    if (window.warnTimeout) clearTimeout(window.warnTimeout);
    window.warnTimeout = setTimeout(() => {
        hideWarning();
    }, 6000);
};
window.hideWarning = function() { document.getElementById('signinWarning').style.display = 'none'; };

window.renderDashboard = function(part) {
    const globalContainer = document.getElementById('globalStatsContainer');
    const globalCanvas = document.getElementById('globalStatsChart');
    const dashboardContainer = document.getElementById('dashboardContainer');
    
    // Clear old charts if they exist
    dashboardContainer.innerHTML = '';
    let oldGlobalChart = Chart.getChart(globalCanvas);
    if (oldGlobalChart) oldGlobalChart.destroy();
    
    // Render Global Stats (Success vs Fail)
    const failed = part.total - part.successful;
    new Chart(globalCanvas, {
        type: 'doughnut',
        data: {
            labels: ['Successful', 'Failed'],
            datasets: [{
                data: [part.successful, failed],
                backgroundColor: ['#28a745', '#dc3545'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { color: '#a0a0a0' } },
                title: { display: true, text: 'Total Automations', color: '#fff' }
            }
        }
    });
    
    // Render Per-Question Charts
    part.chart_data.forEach((qData, index) => {
        const card = document.createElement('div');
        card.style.background = 'var(--surface)';
        card.style.border = '1px solid var(--border)';
        card.style.borderRadius = '12px';
        card.style.padding = '16px';
        
        const title = document.createElement('h3');
        title.innerText = qData.question;
        title.style.marginBottom = '16px';
        title.style.fontSize = '14px';
        title.style.color = 'var(--on-surface)';
        card.appendChild(title);
        
        const chartWrapper = document.createElement('div');
        chartWrapper.style.position = 'relative';
        chartWrapper.style.height = '200px';
        chartWrapper.style.width = '100%';
        
        const canvas = document.createElement('canvas');
        chartWrapper.appendChild(canvas);
        card.appendChild(chartWrapper);
        
        dashboardContainer.appendChild(card);
        
        const type = qData.labels.length > 4 ? 'bar' : 'pie';
        
        const bgColors = [
            '#007bff', '#28a745', '#dc3545', '#ffc107', '#17a2b8',
            '#6610f2', '#e83e8c', '#fd7e14', '#20c997', '#6c757d',
            '#a29bfe', '#55efc4', '#ffeaa7', '#fab1a0', '#ff7675'
        ];
        
        new Chart(canvas, {
            type: type,
            data: {
                labels: qData.labels,
                datasets: [{
                    label: 'Responses',
                    data: qData.counts,
                    backgroundColor: bgColors.slice(0, qData.labels.length).concat(Array(Math.max(0, qData.labels.length - bgColors.length)).fill('#6c757d')),
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: type === 'pie',
                        position: 'right',
                        labels: { color: '#a0a0a0', font: { size: 10 } }
                    }
                },
                scales: type === 'bar' ? {
                    y: { beginAtZero: true, grid: { color: '#333' }, ticks: { color: '#a0a0a0' } },
                    x: { grid: { display: false }, ticks: { color: '#a0a0a0', maxRotation: 45, minRotation: 45 } }
                } : {}
            }
        });
    });
};
