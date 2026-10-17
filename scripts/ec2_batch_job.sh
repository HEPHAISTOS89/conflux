#!/bin/bash
# EC2 user-data for the RoadScope batch worker (AL2023 arm64).
# Installs a systemd oneshot that runs on EVERY boot: pull job from S3, build
# trajectories, upload curated outputs + run record, then power off. Because
# instance-initiated shutdown behaviour is "stop", the box returns to stopped
# (EBS only, ~$1/mo) until EventBridge Scheduler starts it again.
# __DATA_BUCKET__ is substituted by CDK at synth time.
set -euxo pipefail
dnf install -y python3.12 python3.12-pip tar gzip
cat > /usr/local/bin/roadscope-job.sh <<'JOB'
#!/bin/bash
set -uxo pipefail
B=__DATA_BUCKET__
TS=$(date -u +%Y%m%dT%H%M%SZ)
W=/opt/roadscope; rm -rf "$W"; mkdir -p "$W" && cd "$W"
STATUS=failed
if aws s3 cp "s3://$B/jobs/pipeline.tar.gz" job.tar.gz && tar xzf job.tar.gz; then
  python3.12 -m venv .venv && .venv/bin/pip install -q -r requirements.txt \
  && mkdir -p out && { aws s3 cp "s3://$B/curated/manifest.json" out/manifest.json || true; } \
  && .venv/bin/python -m roadscope_pipeline.trajectory.build --out out --cache raw/ngsim \
  && aws s3 sync out/intersections "s3://$B/curated/intersections/" --content-type application/json \
  && aws s3 cp out/manifest.json "s3://$B/curated/manifest.json" --content-type application/json \
  && STATUS=succeeded
fi
printf '{"run_id":"%s","job":"trajectories","status":"%s","finished_at":"%s"}\n' \
  "$TS" "$STATUS" "$(date -u +%FT%TZ)" > run.json
aws s3 cp run.json "s3://$B/curated/runs/$TS.json" --content-type application/json
JOB
chmod +x /usr/local/bin/roadscope-job.sh
cat > /etc/systemd/system/roadscope-job.service <<'UNIT'
[Unit]
Description=RoadScope batch job (runs once per boot, then powers off)
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/roadscope-job.sh
ExecStopPost=/usr/sbin/shutdown -h +1
TimeoutStartSec=3h
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now roadscope-job.service || true
