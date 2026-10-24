from flask import Flask, request, jsonify, render_template, Response, stream_with_context
from forms import generate_questions, get_reliable_action_url, generate_responses_stream, generated_csv_cache

app = Flask(__name__)

PRODUCTION_MODE = True

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/parse', methods=['POST'])
def parse_form():
    data = request.json
    form_url = data.get('form_url')
    if not form_url:
        return jsonify({'error': 'No URL provided'}), 400
    
    return Response(stream_with_context(generate_questions(form_url)), mimetype='application/x-ndjson')

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

    action_url = get_reliable_action_url(action_url, form_url)
    if not action_url:
        return jsonify({'error': 'Could not determine formResponse URL. Please check your Form URL.'}), 400

    return Response(stream_with_context(generate_responses_stream(
        num_responses, action_url, questions, hidden_fields, weights_map
    )), mimetype='application/x-ndjson')

@app.route('/download/<job_id>')
def download_csv(job_id):
    cache_entry = generated_csv_cache.get(job_id)
    if not cache_entry: return "Not found", 404
    
    file_type = request.args.get('type', 'responses')
    content = cache_entry.get(file_type, cache_entry['responses'] if isinstance(cache_entry, dict) else cache_entry)
    
    filename = f"{file_type}_{job_id}.csv"
    return Response(content, mimetype="text/csv", headers={"Content-disposition": f"attachment; filename={filename}"})

if __name__ == '__main__':
    app.run(debug=not PRODUCTION_MODE)