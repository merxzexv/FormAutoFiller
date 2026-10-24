import requests
from bs4 import BeautifulSoup
import random
import time
import csv
import io
import re
import json
from datetime import datetime, timedelta

def parse_and_generate_special_response(chosen):
    if chosen.startswith('__GEN_DATE__|'):
        parts = chosen.split('|')
        if len(parts) == 3:
            try:
                start_date = datetime.strptime(parts[1], '%Y-%m-%d')
                end_date = datetime.strptime(parts[2], '%Y-%m-%d')
                if start_date > end_date:
                    start_date, end_date = end_date, start_date
                delta = end_date - start_date
                random_days = random.randint(0, delta.days)
                return (start_date + timedelta(days=random_days)).strftime('%Y-%m-%d')
            except Exception:
                pass
    elif chosen.startswith('__GEN_NUM__|'):
        parts = chosen.split('|')
        if len(parts) == 3:
            try:
                if '.' in parts[1] or '.' in parts[2]:
                    min_val = float(parts[1])
                    max_val = float(parts[2])
                    if min_val > max_val:
                        min_val, max_val = max_val, min_val
                    return str(round(random.uniform(min_val, max_val), 2))
                else:
                    min_val = int(parts[1])
                    max_val = int(parts[2])
                    if min_val > max_val:
                        min_val, max_val = max_val, min_val
                    return str(random.randint(min_val, max_val))
            except Exception:
                pass
    return chosen

def format_option_label(opt):
    if opt.startswith('__GEN_DATE__|'):
        parts = opt.split('|')
        if len(parts) == 3:
            return f"Date Range: {parts[1]} to {parts[2]}"
    elif opt.startswith('__GEN_NUM__|'):
        parts = opt.split('|')
        if len(parts) == 3:
            return f"Number Range: {parts[1]} to {parts[2]}"
    return opt

# Global store for temporary CSV results
generated_csv_cache = {}

def is_signin_required(html):
    """Check if the form MANDATORILY requires Google sign-in."""
    soup = BeautifulSoup(html, 'html.parser')
    # If the main form container is present, sign-in is likely NOT mandatory
    # even if there's a "Sign in" button for saving progress.
    if soup.find('form', id='mG61Hd'):
        return False
        
    # Check for specific mandatory sign-in language
    mandatory_strings = [
        r"Sign in to your Google account to fill out this form",
        r"You need to sign in to open this form",
        r"To continue, sign in to Google"
    ]
    for pattern in mandatory_strings:
        if soup.find(string=re.compile(pattern, re.I)):
            return True
            
    # Fallback: if no form found and we see general sign-in text
    if soup.find(string=re.compile(r"Sign in to Google", re.I)):
        return True
        
    return False

def is_form_closed(html):
    """Check if the form is no longer accepting responses."""
    soup = BeautifulSoup(html, 'html.parser')
    closed_text = soup.find(string=re.compile(r"no longer accepting responses", re.I))
    return closed_text is not None

def extract_hidden_fields(soup):
    """Extract hidden input values (fvv, fbzx, pageHistory, etc.)."""
    hidden = {}
    for inp in soup.find_all('input', type='hidden'):
        name = inp.get('name')
        value = inp.get('value', '')
        if name:
            hidden[name] = value
    return hidden

def extract_questions_from_json(data):
    """
    Decodes the FB_PUBLIC_LOAD_DATA_ structure using the precise indices 
    from a standard Google Form dump.
    """
    try:
        # data[1][1] is the main items list
        items = data[1][1]
        pages = []
        current_page_questions = []
        page_idx = 0

        for item in items:
            if not item or len(item) < 4: continue
            
            # item[3] is the Type ID
            type_id = item[3]
            
            # Type 8 is a Page Break / Section
            if type_id == 8:
                if current_page_questions:
                    pages.append(current_page_questions)
                    current_page_questions = []
                page_idx += 1
                continue

            # item[4] contains the entry data
            if not item[4]: continue
            
            try:
                entry_data = item[4][0]
                entry_id = f"entry.{entry_data[0]}"
                text = item[1] or ""
                question_desc = item[2] or "" if len(item) > 2 and item[2] else ""
                is_required = bool(len(entry_data) > 2 and entry_data[2] == 1)

                TYPE_NAMES = {
                    0: "Short answer",
                    1: "Paragraph",
                    2: "Multiple choice",
                    3: "Dropdown",
                    4: "Checkboxes",
                    5: "Multiple choice grid",
                    7: "Linear scale",
                    9: "Date",
                    10: "Time",
                }
                
                # Supported types: 
                # 2: Multiple Choice (Radio), 3: Dropdown, 4: Checkboxes, 7: Linear Scale
                if type_id in [2, 3, 4]:
                    type_name = "Checkboxes" if type_id == 4 else ("Dropdown" if type_id == 3 else "Multiple choice")
                    q = {
                        'text': text,
                        'label': text,
                        'entry_id': entry_id,
                        'entry': entry_id,
                        'type': 'checkbox' if type_id == 4 else 'radio',
                        'type_name': type_name,
                        'required': is_required,
                        'description': question_desc,
                        'page': page_idx
                    }
                    # Options are at entry_data[1]
                    raw_options = entry_data[1] 
                    options = [opt[0] for opt in raw_options if opt and opt[0]]
                    if options:
                        q['options'] = options
                        current_page_questions.append(q)
                
                elif type_id == 7:
                    q = {
                        'text': text,
                        'label': text,
                        'entry_id': entry_id,
                        'entry': entry_id,
                        'type': 'linear',
                        'type_name': "Linear scale",
                        'required': is_required,
                        'description': question_desc,
                        'page': page_idx
                    }
                    # Scale data at entry_data[10]
                    scale = entry_data[10]
                    q['min'] = int(scale[0])
                    q['max'] = int(scale[1])
                    q['left_label'] = scale[2] if len(scale) > 2 else ""
                    q['right_label'] = scale[3] if len(scale) > 3 else ""
                    current_page_questions.append(q)
                
                else:
                    type_name = TYPE_NAMES.get(type_id, "Short answer" if type_id == 0 else ("Paragraph" if type_id == 1 else "Text"))
                    q = {
                        'text': text,
                        'label': text,
                        'entry_id': entry_id,
                        'entry': entry_id,
                        'type': 'text',
                        'type_name': type_name,
                        'required': is_required,
                        'description': question_desc,
                        'options': [],
                        'page': page_idx
                    }
                    current_page_questions.append(q)
            except: continue

        # Add any remaining questions
        if current_page_questions:
            pages.append(current_page_questions)
            
        return pages
    except Exception as e:
        print(f"Extraction Error: {e}")
        return []

def extract_form_title(soup, raw_data):
    """Robustly extracts the actual Google Form title."""
    if raw_data:
        try:
            if len(raw_data) > 1 and len(raw_data[1]) > 8 and raw_data[1][8]:
                t = str(raw_data[1][8]).strip()
                if t and t.lower() not in ["google forms", "google form"]:
                    return t
        except Exception:
            pass
        try:
            if len(raw_data) > 3 and raw_data[3]:
                t = str(raw_data[3]).strip()
                if t and t.lower() not in ["google forms", "google form"]:
                    return t
        except Exception:
            pass

    for selector in [
        ('div', {'role': 'heading', 'aria-level': '1'}),
        ('div', {'class': 'F9HgFd'}),
        ('div', {'class': 'freebirdFormviewerViewHeaderTitle'}),
        ('meta', {'property': 'og:title'})
    ]:
        tag = soup.find(selector[0], selector[1])
        if tag:
            val = tag.get('content') if tag.name == 'meta' else tag.get_text()
            if val:
                val = re.sub(r'\s*-\s*Google Forms\s*$', '', val.strip(), flags=re.I).strip()
                if val and val.lower() not in ["google forms", "google form"]:
                    return val

    title_tag = soup.find('title')
    if title_tag and title_tag.string:
        val = re.sub(r'\s*-\s*Google Forms\s*$', '', title_tag.string.strip(), flags=re.I).strip()
        if val and val.lower() not in ["google forms", "google form"]:
            return val

    return "Google Form"

def extract_form_desc(soup, raw_data):
    if raw_data:
        try:
            if len(raw_data) > 1 and len(raw_data[1]) > 0 and raw_data[1][0]:
                return str(raw_data[1][0]).strip()
        except Exception:
            pass
    og_desc = soup.find('meta', property='og:description')
    if og_desc and og_desc.get('content'):
        return og_desc['content'].strip()
    return ""

def generate_questions(form_url):
    try:
        response = requests.get(form_url)
        response.raise_for_status()
        html = response.text
        soup = BeautifulSoup(html, 'html.parser')
        
        form_tag = soup.find('form', id='mG61Hd')
        action_url = form_tag.get('action') if form_tag else None
        hidden_fields = extract_hidden_fields(soup)
        
        # Parse the JSON structure for multi-page support without a browser
        results = re.search(r'var FB_PUBLIC_LOAD_DATA_ = (\[.*?\]);', html, re.DOTALL)
        json_pages = []
        raw_data = None
        if results:
            raw_data = json.loads(results.group(1))
            json_pages = extract_questions_from_json(raw_data)
            num_pages = len(json_pages)
            if num_pages > 0:
                hidden_fields['pageHistory'] = ','.join(str(i) for i in range(num_pages))

        form_title = extract_form_title(soup, raw_data)
        form_desc = extract_form_desc(soup, raw_data)

        yield json.dumps({
            'type': 'metadata',
            'action_url': action_url,
            'form_url': form_url,
            'form_title': form_title,
            'form_description': form_desc,
            'hidden_fields': hidden_fields,
            'requires_signin': is_signin_required(html),
            'is_closed': is_form_closed(html)
        }) + "\n"

        if results:
            for page in json_pages:
                yield json.dumps({'type': 'questions', 'data': page}) + "\n"
        else:
            yield json.dumps({'type': 'error', 'message': 'Failed to locate form structure.'}) + "\n"
            
    except Exception as e:
        yield json.dumps({'type': 'error', 'message': str(e)}) + "\n"

def get_reliable_action_url(action_url, form_url):
    """Ensure we have a valid action URL for submission."""
    if not action_url or 'formResponse' not in str(action_url):
        # Look for the 56-character form ID in the form_url or action_url
        id_match = re.search(r'/d/e/([^/]+)', f"{action_url} {form_url}")
        if id_match:
            action_url = f"https://docs.google.com/forms/d/e/{id_match.group(1)}/formResponse"
        else:
            return None
    
    # If action_url is relative (e.g. starting with /forms)
    if action_url.startswith('/'):
        action_url = "https://docs.google.com" + action_url
    if 'formResponse' not in action_url:
        action_url = action_url.rsplit('/', 1)[0] + '/formResponse'
        
    return action_url

def generate_responses_stream(num_responses, action_url, questions, hidden_fields, weights_map):
    # Ensure pageHistory accurately reflects all pages in multi-page forms
    max_page = max([q.get('page', 0) for q in questions], default=0)
    current_history = str(hidden_fields.get('pageHistory', ''))
    if max_page > 0:
        expected_history = ','.join(str(p) for p in range(max_page + 1))
        if not current_history or current_history == '0' or len(current_history.split(',')) <= max_page:
            hidden_fields['pageHistory'] = expected_history

    responses_for_csv = []
    stats = {}
    for q in questions:
        eid = q.get('entry_id')
        if not eid: continue
        if q.get('type') == 'linear':
            stats[eid] = {str(i): 0 for i in range(int(q.get('min', 0)), int(q.get('max', 5)) + 1)}
        else:
            stats[eid] = {opt: 0 for opt in q.get('options', [])}

    successful_submissions = 0
    http = requests.Session()

    for i in range(num_responses):
        form_payload = {**hidden_fields}
        csv_row = {}
        
        for q in questions:
            eid = q['entry_id']
            w = weights_map.get(eid) or {}
            
            if q['type'] in ['radio', 'checkbox', 'dropdown', 'text']:
                opts = q.get('options', [])
                if not opts: continue
                opt_weights = [float(w.get(o, 1)) for o in opts]
                if sum(opt_weights) == 0: opt_weights = [1] * len(opts)
                
                chosen = random.choices(opts, weights=opt_weights, k=1)[0]
                generated_val = parse_and_generate_special_response(chosen)
                form_payload[eid] = generated_val
                csv_row[q['text']] = generated_val
                if eid in stats and chosen in stats[eid]:
                    stats[eid][chosen] += 1
            elif q['type'] == 'linear':
                vals = [str(v) for v in range(int(q['min']), int(q['max']) + 1)]
                opt_weights = [float(w.get(str(v), 1)) for v in vals]
                if sum(opt_weights) == 0: opt_weights = [1] * len(vals)
                
                chosen = random.choices(vals, weights=opt_weights, k=1)[0]
                form_payload[eid] = chosen
                csv_row[q['text']] = chosen
                if eid in stats and chosen in stats[eid]:
                    stats[eid][chosen] += 1
        
        try:
            if i > 0:
                time.sleep(random.uniform(0.05, 0.2))
            response = http.post(action_url, data=form_payload, timeout=10)
            if response.status_code == 200:
                successful_submissions += 1
                responses_for_csv.append(csv_row)
        except: pass

        yield json.dumps({
            'type': 'progress', 'current': i + 1, 'total': num_responses, 'successful': successful_submissions
        }) + "\n"

    # 1. Create Responses CSV
    responses_output = io.StringIO()
    if responses_for_csv:
        fieldnames = list(responses_for_csv[0].keys())
        writer = csv.DictWriter(responses_output, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(responses_for_csv)
    
    # 2. Create Statistics CSV
    stats_output = io.StringIO()
    stats_writer = csv.writer(stats_output)
    stats_writer.writerow(['Question', 'Option', 'Count', 'Percentage'])
    for q in questions:
        q_stats = stats.get(q['entry_id'], {})
        for opt, count in q_stats.items():
            perc = (count / num_responses) * 100 if num_responses > 0 else 0
            label = format_option_label(opt)
            stats_writer.writerow([q['text'], label, count, f"{perc:.1f}%"])

    job_id = str(int(time.time()))
    generated_csv_cache[job_id] = {
        'responses': responses_output.getvalue(),
        'stats': stats_output.getvalue()
    }

    # 3. Text Summary
    summary = f"Total Submissions: {num_responses}\nSuccessful: {successful_submissions}\n\n"
    chart_data = []
    for q in questions:
        summary += f"--- {q['text']} ---\n"
        q_stats = stats.get(q['entry_id'], {})
        sorted_opts = sorted(q_stats.items(), key=lambda x: x[1], reverse=True)
        
        labels = []
        counts = []
        
        for opt, count in sorted_opts:
            perc = (count / num_responses) * 100 if num_responses > 0 else 0
            label = format_option_label(opt)
            labels.append(label)
            counts.append(count)
            summary += f"{label}: {count} / {num_responses} ({perc:.1f}%)\n"
        summary += "\n"
        
        chart_data.append({
            'question': q['text'],
            'labels': labels,
            'counts': counts
        })

    yield json.dumps({
        'type': 'complete', 
        'summary': summary, 
        'job_id': job_id,
        'total': num_responses,
        'successful': successful_submissions,
        'chart_data': chart_data
    }) + "\n"
