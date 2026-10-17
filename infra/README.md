# Deployment shape (no cloud resources created)

- Frontend deploy target: Vercel (Vite build, `VITE_API_BASE_URL`).
- API deploy target: ECR + ECS Fargate behind an ALB; `/health` is the target health check.
- Object storage target: private S3 prefixes `raw/`, `validated/`, `normalized/`, `features/`, `events/`.
- Observability: CloudWatch logs/alarms; add an AWS budget before creating billable resources.

This prototype intentionally ships deterministic synthetic data. Replace the fixture with a reviewed, licensed source and record provenance before production use.
