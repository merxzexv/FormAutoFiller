import io, re, csv, json, time, random, requests
from datetime import datetime, timedelta
from bs4 import BeautifulSoup

generated_csv_cache = {}

TYPE_NAMES = {
    0: "Short answer", 1: "Paragraph", 2: "Multiple choice", 3: "Dropdown",
    4: "Checkboxes", 5: "Linear scale", 7: "Multiple choice grid",
    9: "Date", 10: "Time", 18: "Rating"
}

def parse_and_generate_special_response(chosen):
    if not isinstance(chosen, str) or not chosen.startswith('__GEN_'):
        return chosen
    parts = chosen.split('|')
    if len(parts) == 3:
        try:
            if parts[0] == '__GEN_DATE__':
                d1, d2 = sorted([datetime.strptime(p, '%Y-%m-%d') for p in parts[1:3]])
                return (d1 + timedelta(days=random.randint(0, (d2 - d1).days))).strftime('%Y-%m-%d')
            if parts[0] == '__GEN_TIME__':
                t1 = [int(x) for x in parts[1].split(':')]
                t2 = [int(x) for x in parts[2].split(':')]
                m1, m2 = sorted([t1[0] * 60 + t1[1], t2[0] * 60 + t2[1]])
                rand_m = random.randint(m1, m2)
                return f"{rand_m // 60:02d}:{rand_m % 60:02d}"
            if parts[0] == '__GEN_NUM__':
                is_float = '.' in parts[1] or '.' in parts[2]
                v1, v2 = sorted([float(parts[1]), float(parts[2])] if is_float else [int(parts[1]), int(parts[2])])
                return str(round(random.uniform(v1, v2), 2) if is_float else random.randint(v1, v2))
        except Exception:
            pass
    return chosen

def format_option_label(opt):
    p = opt.split('|') if isinstance(opt, str) and opt.startswith('__GEN_') else []
    if len(p) == 3:
        if p[0] == '__GEN_DATE__': return f"Date Range: {p[1]} to {p[2]}"
        if p[0] == '__GEN_TIME__': return f"Time Range: {p[1]} to {p[2]}"
        if p[0] == '__GEN_NUM__': return f"Number Range: {p[1]} to {p[2]}"
    return str(opt)

def is_signin_required(html):
    soup = BeautifulSoup(html, 'html.parser')
    if soup.find('form', id='mG61Hd'):
        return False
    return bool(soup.find(string=re.compile(r'Sign in to (your Google account|Google)|You need to sign in|To continue, sign in', re.I)))

def is_form_closed(html):
    return bool(BeautifulSoup(html, 'html.parser').find(string=re.compile(r'no longer accepting responses', re.I)))

def extract_hidden_fields(soup):
    return {inp.get('name'): inp.get('value', '') for inp in soup.find_all('input', type='hidden') if inp.get('name')}

def extract_scale_bounds(entry, tid):
    if len(entry) > 10 and entry[10] and isinstance(entry[10], (list, tuple)) and len(entry[10]) >= 2:
        try:
            return int(entry[10][0]), int(entry[10][1]), str(entry[10][2] if len(entry[10]) > 2 and entry[10][2] else ""), str(entry[10][3] if len(entry[10]) > 3 and entry[10][3] else "")
        except Exception: pass
    if len(entry) > 1 and entry[1] and isinstance(entry[1], list):
        opts = [opt[0] for opt in entry[1] if opt and opt[0]]
        if opts and all(str(o).isdigit() for o in opts):
            nums = [int(o) for o in opts]
            return min(nums), max(nums), "", ""
    return (1, 5, "", "") if tid in (5, 18) else (1, 5, "", "")

def is_soup_checkbox_grid(soup, item, entry, row_name):
    if not soup: return False
    eid_str = str(entry[0]) if entry and len(entry) > 0 else ""
    if row_name:
        row_el = soup.find(lambda el: el.name in ('div', 'tr') and el.get('role') == 'row' and row_name in el.get_text())
        if row_el:
            if row_el.find(attrs={'role': 'checkbox'}) or row_el.find(class_=re.compile(r'checkbox', re.I)):
                return True
            if row_el.find(attrs={'role': 'radio'}) or row_el.find(class_=re.compile(r'radio', re.I)):
                return False
    target = None
    if eid_str:
        target = (soup.find(attrs={'name': f"entry.{eid_str}"}) or 
                  soup.find(attrs={'name': f"entry.{eid_str}_sentinel"}) or
                  soup.find(attrs={'data-params': re.compile(rf'\b{eid_str}\b')}) or
                  soup.find(attrs={'data-item-id': eid_str}))
    if not target and item and len(item) > 1 and item[1]:
        title = str(item[1]).strip()
        if title:
            target = soup.find(lambda el: el.name in ('div', 'span', 'h1', 'h2', 'h3') and title in el.get_text())
    if target:
        curr = target
        container = None
        while curr and curr.name != 'body':
            if curr.get('role') == 'listitem' or any(c in curr.get('class', []) for c in ['Qr7Oae', 'geS5n', 'freebirdFormviewerViewItemList']):
                container = curr
                break
            curr = curr.parent
        if not container:
            curr = target
            for _ in range(5):
                if curr.parent and curr.parent.name != 'body':
                    curr = curr.parent
            container = curr
        if container:
            if container.find(attrs={'role': 'checkbox'}) or container.find(class_=re.compile(r'checkbox', re.I)):
                return True
            if container.find(attrs={'role': 'radio'}) or container.find(attrs={'role': 'radiogroup'}) or container.find(class_=re.compile(r'radio', re.I)):
                return False
    return False

def is_json_checkbox_grid(item, entry):
    try:
        if len(entry) > 4 and (entry[4] == 1 or entry[4] == [1]): return True
        if len(entry) > 11 and (entry[11] == 1 or entry[11] == [1]): return True
        if item and len(item) > 4 and isinstance(item[4], list):
            for row in item[4]:
                if isinstance(row, list):
                    if len(row) > 4 and (row[4] == 1 or row[4] == [1]): return True
                    if len(row) > 11 and (row[11] == 1 or row[11] == [1]): return True
                    for x in row[4:]:
                        if x == 1 or x == [1]: return True
        if item and len(item) > 7:
            for x in item[7:]:
                if x == 1 or x == [1]: return True
    except Exception:
        pass
    return False

def extract_questions_from_json(data, soup=None):
    try:
        pages, cur_page, page_idx = [], [], 0
        items = data[1][1] if data and len(data) > 1 and len(data[1]) > 1 else []
        for item in items:
            if not item or len(item) < 4: continue
            tid = item[3]
            if tid == 8:
                if cur_page: pages.append(cur_page); cur_page = []
                page_idx += 1
                continue
            if not item[4] or not isinstance(item[4], list): continue

            text = item[1] or ""
            desc = item[2] if len(item) > 2 and item[2] else ""
            is_grid = (tid == 7) or (len(item[4]) > 1 and tid not in (0, 1))

            for sub_idx, entry in enumerate(item[4]):
                if not entry or not isinstance(entry, list) or len(entry) == 0: continue
                try:
                    eid = f"entry.{entry[0]}"
                    req = bool(len(entry) > 2 and entry[2] == 1)

                    row_name = ""
                    if is_grid and len(entry) > 3 and entry[3]:
                        row_name = entry[3][0] if isinstance(entry[3], list) and entry[3] else str(entry[3])
                    elif is_grid and len(item[4]) > 1:
                        row_name = f"Row {sub_idx + 1}"

                    q_text = f"{text} [{row_name}]" if (is_grid and row_name) else text
                    tname = TYPE_NAMES.get(tid, "Text")

                    if tid in (5, 18) or (len(entry) > 10 and entry[10]):
                        qtype = 'rating' if tid == 18 else 'linear'
                        tname = "Rating" if tid == 18 else "Linear scale"
                        min_v, max_v, l_lbl, r_lbl = extract_scale_bounds(entry, tid)
                        cur_page.append({
                            'text': q_text, 'label': q_text, 'entry_id': eid, 'entry': eid,
                            'type': qtype, 'type_name': tname, 'required': req,
                            'description': desc, 'page': page_idx,
                            'min': min_v, 'max': max_v, 'left_label': l_lbl, 'right_label': r_lbl
                        })
                    elif tid in (2, 3, 4) or is_grid or (len(entry) > 1 and entry[1]):
                        raw_opts = entry[1] if len(entry) > 1 and entry[1] else []
                        opts = [opt[0] for opt in raw_opts if opt and opt[0]]
                        is_checkbox_grid = is_grid and (
                            (tid == 4) or
                            is_soup_checkbox_grid(soup, item, entry, row_name) or
                            is_json_checkbox_grid(item, entry) or
                            bool(re.search(r'\b(checkbox|check all|select all|tick all)\b', f"{text} {desc}", re.I))
                        )
                        is_cb = (tid == 4) or is_checkbox_grid
                        qtype = 'checkbox' if is_cb else 'radio'
                        if is_grid: tname = "Checkbox grid" if is_checkbox_grid else "Multiple choice grid"
                        elif tid == 3: tname = "Dropdown"
                        elif tid == 4: tname = "Checkboxes"
                        elif tid == 2: tname = "Multiple choice"
                        cur_page.append({
                            'text': q_text, 'label': q_text, 'entry_id': eid, 'entry': eid,
                            'type': qtype, 'type_name': tname, 'required': req,
                            'description': desc, 'page': page_idx,
                            'options': opts
                        })
                    else:
                        qtype = 'time' if tid == 10 else ('date' if tid == 9 else 'text')
                        if tid == 9:
                            tname = "Date"
                            def_opts = [f"__GEN_DATE__|{datetime.now().strftime('%Y-%m-%d')}|{(datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d')}"]
                        elif tid == 10:
                            tname = "Time"
                            def_opts = ["__GEN_TIME__|09:00|17:00"]
                        else:
                            def_opts = []
                        cur_page.append({
                            'text': q_text, 'label': q_text, 'entry_id': eid, 'entry': eid,
                            'type': qtype, 'type_name': tname, 'required': req,
                            'description': desc, 'page': page_idx,
                            'options': def_opts
                        })
                except Exception:
                    continue
        if cur_page: pages.append(cur_page)
        return pages
    except Exception:
        return []

def extract_form_title(soup, raw_data):
    if raw_data:
        for idx in ((1, 8), (3,)):
            try:
                t = raw_data[idx[0]][idx[1]] if len(idx) > 1 else raw_data[idx[0]]
                if t and str(t).strip().lower() not in ["google forms", "google form"]:
                    return str(t).strip()
            except Exception: pass
    for sel in [{'role': 'heading', 'aria-level': '1'}, {'class': 'F9HgFd'}, {'class': 'freebirdFormviewerViewHeaderTitle'}]:
        el = soup.find('div', sel)
        if el and el.get_text(strip=True):
            t = re.sub(r'\s*-\s*Google Forms\s*$', '', el.get_text(strip=True), flags=re.I).strip()
            if t.lower() not in ["google forms", "google form"]: return t
    og = soup.find('meta', property='og:title') or soup.find('title')
    if og:
        val = (og.get('content') if og.name == 'meta' else og.string or '').strip()
        val = re.sub(r'\s*-\s*Google Forms\s*$', '', val, flags=re.I).strip()
        if val and val.lower() not in ["google forms", "google form"]: return val
    return "Google Form"

def extract_form_desc(soup, raw_data):
    try:
        if raw_data and raw_data[1][0]: return str(raw_data[1][0]).strip()
    except Exception: pass
    og = soup.find('meta', property='og:description')
    return og.get('content', '').strip() if og else ""

def get_reliable_action_url(action_url, form_url):
    m = re.search(r'/d/e/([^/]+)', f"{action_url} {form_url}")
    if m:
        return f"https://docs.google.com/forms/d/e/{m.group(1)}/formResponse"
    if action_url:
        url = "https://docs.google.com" + action_url if action_url.startswith('/') else action_url
        return url if 'formResponse' in url else url.rsplit('/', 1)[0] + '/formResponse'
    return None

def generate_questions(form_url):
    try:
        res = requests.get(form_url, timeout=15)
        res.raise_for_status()
        html = res.text
        soup = BeautifulSoup(html, 'html.parser')
        form_tag = soup.find('form', id='mG61Hd')
        hidden_fields = extract_hidden_fields(soup)
        
        match = re.search(r'var FB_PUBLIC_LOAD_DATA_ = (\[.*?\]);', html, re.DOTALL)
        raw_data = json.loads(match.group(1)) if match else None
        pages = extract_questions_from_json(raw_data, soup) if raw_data else []
        if pages:
            hidden_fields['pageHistory'] = ','.join(str(i) for i in range(len(pages)))

        yield json.dumps({
            'type': 'metadata',
            'action_url': form_tag.get('action') if form_tag else None,
            'form_url': form_url,
            'form_title': extract_form_title(soup, raw_data),
            'form_description': extract_form_desc(soup, raw_data),
            'hidden_fields': hidden_fields,
            'requires_signin': is_signin_required(html),
            'is_closed': is_form_closed(html)
        }) + "\n"

        if raw_data:
            for page in pages:
                yield json.dumps({'type': 'questions', 'data': page}) + "\n"
        else:
            yield json.dumps({'type': 'error', 'message': 'Failed to locate form structure.'}) + "\n"
    except Exception as e:
        yield json.dumps({'type': 'error', 'message': str(e)}) + "\n"

def generate_responses_stream(num_responses, action_url, questions, hidden_fields, weights_map):
    max_page = max([q.get('page', 0) for q in questions], default=0)
    if max_page > 0:
        hidden_fields['pageHistory'] = ','.join(str(p) for p in range(max_page + 1))

    stats = {}
    for q in questions:
        eid = q.get('entry_id')
        if not eid: continue
        opts = [str(i) for i in range(int(q.get('min', 1)), int(q.get('max', 5)) + 1)] if q.get('type') in ('linear', 'rating') else q.get('options', [])
        stats[eid] = {opt: 0 for opt in opts}

    responses_csv, success_count = [], 0
    http = requests.Session()

    for i in range(num_responses):
        payload = {**hidden_fields}
        csv_row = {}
        for q in questions:
            eid, qtype = q.get('entry_id'), q.get('type')
            opts = [str(v) for v in range(int(q.get('min', 1)), int(q.get('max', 5)) + 1)] if qtype in ('linear', 'rating') else q.get('options', [])
            if not opts or not eid: continue
            w = weights_map.get(eid) or {}
            weights = [float(w.get(o, 1)) for o in opts]
            chosen = random.choices(opts, weights=weights if sum(weights) > 0 else [1] * len(opts), k=1)[0]
            val = parse_and_generate_special_response(chosen) if qtype not in ('linear', 'rating') else chosen
            payload[eid] = val
            csv_row[q['text']] = val
            tm = re.match(r'^(\d{1,2}):(\d{2})$', str(val))
            if tm:
                payload[f"{eid}_hour"] = tm.group(1).zfill(2)
                payload[f"{eid}_minute"] = tm.group(2)
            dm = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', str(val))
            if dm:
                payload[f"{eid}_year"] = dm.group(1)
                payload[f"{eid}_month"] = dm.group(2)
                payload[f"{eid}_day"] = dm.group(3)
            if eid in stats and chosen in stats[eid]:
                stats[eid][chosen] += 1

        try:
            if i > 0: time.sleep(random.uniform(0.05, 0.2))
            if http.post(action_url, data=payload, timeout=10).status_code == 200:
                success_count += 1
                responses_csv.append(csv_row)
        except Exception: pass

        yield json.dumps({'type': 'progress', 'current': i + 1, 'total': num_responses, 'successful': success_count}) + "\n"

    # CSV Generation (Responses & Statistics)
    resp_buf = io.StringIO()
    if responses_csv:
        writer = csv.DictWriter(resp_buf, fieldnames=list(responses_csv[0].keys()))
        writer.writeheader()
        writer.writerows(responses_csv)

    stats_buf = io.StringIO()
    stats_writer = csv.writer(stats_buf)
    stats_writer.writerow(['Question', 'Option', 'Count', 'Percentage'])
    
    summary = f"Total Submissions: {num_responses}\nSuccessful: {success_count}\n\n"
    chart_data = []

    for q in questions:
        eid = q.get('entry_id')
        q_stats = stats.get(eid, {})
        sorted_opts = sorted(q_stats.items(), key=lambda x: x[1], reverse=True)
        summary += f"--- {q['text']} ---\n"
        labels, counts = [], []
        for opt, cnt in sorted_opts:
            perc = (cnt / num_responses * 100) if num_responses > 0 else 0
            lbl = format_option_label(opt)
            labels.append(lbl); counts.append(cnt)
            stats_writer.writerow([q['text'], lbl, cnt, f"{perc:.1f}%"])
            summary += f"{lbl}: {cnt} / {num_responses} ({perc:.1f}%)\n"
        summary += "\n"
        chart_data.append({'question': q['text'], 'labels': labels, 'counts': counts})

    job_id = str(int(time.time()))
    generated_csv_cache[job_id] = {'responses': resp_buf.getvalue(), 'stats': stats_buf.getvalue()}

    yield json.dumps({
        'type': 'complete', 'summary': summary, 'job_id': job_id,
        'total': num_responses, 'successful': success_count, 'chart_data': chart_data
    }) + "\n"
