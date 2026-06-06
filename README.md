# DocuSense

DocuSense is a hackathon prototype for transforming inaccessible research paper PDFs into semantic HTML that works better with Microsoft Edge Read Aloud and screen readers.

The goal is reading-order repair, cleaned front matter, and clearly labeled diagram or figure explanations alongside the paper's written content. DocuSense is not intended to summarize papers.

## Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Set GEMINI_API_KEY in .env
uvicorn app.main:app --reload
```

Health check:

```bash
curl http://localhost:8000/health
```

## Extension

```bash
cd extension
npm install
npm run build
```

Load `extension/dist` as an unpacked extension in Microsoft Edge.

## Notes

- Local upload is the most reliable demo flow.
- PDF URL processing blocks localhost and private network targets.
- Results and original PDFs are stored only under `backend/tmp/jobs`.
- PDFs over 50 pages show a warning and can be processed by confirming continue.
