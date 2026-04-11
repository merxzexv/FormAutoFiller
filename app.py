import requests
from bs4 import BeautifulSoup
import random
import time
import csv
import io
import re
import json
from flask import Flask, request, jsonify, render_template, send_file

app = Flask(__name__)

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

@app.route('/')
def index():
    return render_template('index.html')

from flask import Response, stream_with_context

@app.route('/parse', methods=['POST'])
def parse_form():
    data = request.json
    form_url = data.get('form_url')
    if not form_url:
        return jsonify({'error': 'No URL provided'}), 400
    
    def generate_questions():
        try:
            response = requests.get(form_url)
            response.raise_for_status()
            html = response.text
            soup = BeautifulSoup(html, 'html.parser')
            
            form_tag = soup.find('form', id='mG61Hd')
            action_url = form_tag.get('action') if form_tag else None
            hidden_fields = extract_hidden_fields(soup)
            
            yield json.dumps({
                'type': 'metadata',
                'action_url': action_url,
                'hidden_fields': hidden_fields,
                'requires_signin': is_signin_required(html),
                'is_closed': is_form_closed(html)
            }) + "\n"

            # Parse the JSON structure for multi-page support without a browser
            # We look for the array starting with [ and ending with ] specifically to avoid 
            # truncation at internal semicolons in question text.
            results = re.search(r'var FB_PUBLIC_LOAD_DATA_ = (\[.*?\]);', html, re.DOTALL)
            if results:
                raw_data = json.loads(results.group(1))
                json_pages = extract_questions_from_json(raw_data)
                for page in json_pages:
                    yield json.dumps({'type': 'questions', 'data': page}) + "\n"
            else:
                yield json.dumps({'type': 'error', 'message': 'Failed to locate form structure.'}) + "\n"
                
        except Exception as e:
            yield json.dumps({'type': 'error', 'message': str(e)}) + "\n"

    return Response(stream_with_context(generate_questions()), mimetype='application/x-ndjson')

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

        for item in items:
            if not item or len(item) < 4: continue
            
            # item[3] is the Type ID
            type_id = item[3]
            
            # Type 8 is a Page Break / Section
            if type_id == 8:
                if current_page_questions:
                    pages.append(current_page_questions)
                    current_page_questions = []
                continue

            # item[4] contains the entry data
            if not item[4]: continue
            
            try:
                entry_data = item[4][0]
                entry_id = f"entry.{entry_data[0]}"
                text = item[1]
                
                # Supported types: 
                # 2: Multiple Choice (Radio), 3: Dropdown, 4: Checkboxes, 7: Linear Scale
                if type_id in [2, 3, 4]:
                    q = {
                        'text': text,
                        'entry_id': entry_id,
                        'type': 'checkbox' if type_id == 4 else 'radio'
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
                        'entry_id': entry_id,
                        'type': 'linear'
                    }
                    # Scale data at entry_data[10]
                    scale = entry_data[10]
                    q['min'] = int(scale[0])
                    q['max'] = int(scale[1])
                    q['left_label'] = scale[2] if len(scale) > 2 else ""
                    q['right_label'] = scale[3] if len(scale) > 3 else ""
                    current_page_questions.append(q)
            except: continue

        # Add any remaining questions
        if current_page_questions:
            pages.append(current_page_questions)
            
        return pages
    except Exception as e:
        print(f"Extraction Error: {e}")
        return []

# Global store for temporary CSV results
generated_csv_cache = {}

@app.route('/generate', methods=['POST'])
def generate_responses():
    data = request.json or {}
    num_responses = int(data.get('num_responses', 10))
    action_url = (data.get('action_url') or '').strip()
    form_url = (data.get('form_url') or '').strip()
    questions = data.get('questions') or []
    hidden_fields = data.get('hidden_fields') or {}
    weights_map = data.get('weights') or {}

    if not questions:
        return jsonify({'error': 'No questions to submit. Parse the form first.'}), 400

    # RELIABLE URL EXTRACTION
    if not action_url or 'formResponse' not in str(action_url):
        # Look for the 56-character form ID in the form_url or action_url
        id_match = re.search(r'/d/e/([^/]+)', f"{action_url} {form_url}")
        if id_match:
            action_url = f"https://docs.google.com/forms/d/e/{id_match.group(1)}/formResponse"
        else:
            return jsonify({'error': 'Could not determine formResponse URL. Please check your Form URL.'}), 400
    
    # If action_url is relative (e.g. starting with /forms)
    if action_url.startswith('/'):
        action_url = "https://docs.google.com" + action_url
    if 'formResponse' not in action_url:
        action_url = action_url.rsplit('/', 1)[0] + '/formResponse'

    def generate_stream():
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
                
                if q['type'] in ['radio', 'checkbox', 'dropdown']:
                    opts = q.get('options', [])
                    if not opts: continue
                    opt_weights = [float(w.get(o, 1)) for o in opts]
                    if sum(opt_weights) == 0: opt_weights = [1] * len(opts)
                    
                    chosen = random.choices(opts, weights=opt_weights, k=1)[0]
                    form_payload[eid] = chosen
                    csv_row[q['text']] = chosen
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
                stats_writer.writerow([q['text'], opt, count, f"{perc:.1f}%"])

        job_id = str(int(time.time()))
        generated_csv_cache[job_id] = {
            'responses': responses_output.getvalue(),
            'stats': stats_output.getvalue()
        }

        # 3. Text Summary
        summary = f"Total Submissions: {num_responses}\nSuccessful: {successful_submissions}\n\n"
        for q in questions:
            summary += f"--- {q['text']} ---\n"
            q_stats = stats.get(q['entry_id'], {})
            sorted_opts = sorted(q_stats.items(), key=lambda x: x[1], reverse=True)
            for opt, count in sorted_opts:
                perc = (count / num_responses) * 100 if num_responses > 0 else 0
                summary += f"{opt}: {count} / {num_responses} ({perc:.1f}%)\n"
            summary += "\n"

        yield json.dumps({'type': 'complete', 'summary': summary, 'job_id': job_id}) + "\n"

    return Response(stream_with_context(generate_stream()), mimetype='application/x-ndjson')

@app.route('/download/<job_id>')
def download_csv(job_id):
    cache_entry = generated_csv_cache.get(job_id)
    if not cache_entry: return "Not found", 404
    
    file_type = request.args.get('type', 'responses')
    content = cache_entry.get(file_type, cache_entry['responses'] if isinstance(cache_entry, dict) else cache_entry)
    
    filename = f"{file_type}_{job_id}.csv"
    return Response(content, mimetype="text/csv", headers={"Content-disposition": f"attachment; filename={filename}"})

if __name__ == '__main__':
    app.run(debug=True)