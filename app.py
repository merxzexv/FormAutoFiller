from flask import Flask, request, jsonify, render_template, Response, stream_with_context
from forms import generate_questions, get_reliable_action_url, generate_responses_stream, generated_csv_cache

app = Flask(__name__)
PRODUCTION_MODE = True

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/parse', methods=['POST'])
def parse_form():
    url = (request.json or {}).get('form_url')
    if not url: return jsonify({'error': 'No URL provided'}), 400
    return Response(stream_with_context(generate_questions(url)), mimetype='application/x-ndjson')

@app.route('/generate', methods=['POST'])
def generate_responses():
    d = request.json or {}
    questions = d.get('questions') or []
    if not questions: return jsonify({'error': 'No questions to submit. Parse the form first.'}), 400
    action_url = get_reliable_action_url((d.get('action_url') or '').strip(), (d.get('form_url') or '').strip())
    if not action_url: return jsonify({'error': 'Could not determine formResponse URL. Please check your Form URL.'}), 400
    return Response(stream_with_context(generate_responses_stream(
        int(d.get('num_responses', 10)), action_url, questions, d.get('hidden_fields') or {}, d.get('weights') or {}
    )), mimetype='application/x-ndjson')

@app.route('/download/<job_id>')
def download_csv(job_id):
    entry = generated_csv_cache.get(job_id)
    if not entry: return "Not found", 404
    ftype = request.args.get('type', 'responses')
    content = entry.get(ftype, entry['responses'] if isinstance(entry, dict) else entry)
    return Response(content, mimetype="text/csv", headers={"Content-disposition": f"attachment; filename={ftype}_{job_id}.csv"})

if __name__ == '__main__':
    app.run(debug=not PRODUCTION_MODE)