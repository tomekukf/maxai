# maxai — Asystent Sprzedaży (MVP)

Webowe MVP wspierające salon meblowy w dopasowywaniu produktów z wizualizacji
architektonicznych (PDF) do asortymentu. **Wyszukiwarka substytutów**: dla mebla
z wizualizacji zwraca maksymalnie podobne wizualnie produkty z naszej bazy
(z ID z systemu Optima), nawet jeśli to inny producent.

## Dokumentacja
- [`CLAUDE.md`](./CLAUDE.md) — kontekst projektu i konwencje pracy.
- [`PLAN_IMPLEMENTACJI.md`](./PLAN_IMPLEMENTACJI.md) — plan w numerowanych krokach z kryteriami weryfikacji.
- [`max_ai_concept.txt.txt`](./max_ai_concept.txt.txt) — pierwotna koncepcja.

## Stack (skrót)
- Frontend: React (Vite) + TypeScript + Tailwind + shadcn/ui + react-pdf + react-image-crop
- Backend: Python (AWS Lambda) + API Gateway
- Baza: RDS PostgreSQL + pgvector · Storage: S3
- AI: Amazon Bedrock (Claude Haiku 4.5, Claude Sonnet 5, Titan Multimodal Embeddings)
- IaC: AWS CDK · Hosting/CI: AWS Amplify Hosting
- Region: `eu-central-1` · Node: 22

## Struktura
```
frontend/   # aplikacja React (Vite)
backend/    # funkcje Lambda (Python)
infra/      # definicje AWS CDK
scripts/    # narzędzia (np. scraper danych testowych)
docs/       # dodatkowa dokumentacja
```

## Status
Faza 0 (fundament). Szczegóły i kolejne kroki: `PLAN_IMPLEMENTACJI.md`.
