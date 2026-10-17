"""AWS Lambda adapter for the FastAPI app.

The ECS/Fargate template remains the long-running deployment shape. This small
adapter provides a low-cost, reversible live demo path through a Lambda URL.
"""
from mangum import Mangum

from app.main import app

handler = Mangum(app, lifespan="off")
