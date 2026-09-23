# The deployed image.
#
# A container image rather than a zip because the model alone is 208 MB and a
# Lambda zip stops at 250 MB unpacked — onnxruntime and OpenCV do not fit
# beside it. An image has 10 GB, and this one comes to about 1.2.
#
# The model is baked in rather than fetched at cold start. A 208 MB download on
# the first request of every new container would be seconds the client spends
# waiting inside a timeout it will otherwise fall back from, and it would make
# the service's availability depend on Hugging Face's.
FROM public.ecr.aws/lambda/python:3.11

# Pinned to the model repository's commit, not to `main`: the URL then names
# exact bytes, and a new upload there cannot silently change what we deploy.
# The checksum is belt and braces on top of that, and is what makes a truncated
# or intercepted download fail the build instead of producing an image that
# only misbehaves at inference time.
ARG LAMA_ONNX_URL=https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx
ARG LAMA_ONNX_SHA256=1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6

COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN python -m pip install --no-cache-dir --upgrade pip \
 && python -m pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# /opt rather than ${LAMBDA_TASK_ROOT}: the model is not code, and keeping it
# out of the task root means a change to either layer does not invalidate the
# other's cache. This layer is the expensive one to rebuild.
COPY fetch_model.py /tmp/fetch_model.py
RUN mkdir -p /opt/model \
 && python /tmp/fetch_model.py "${LAMA_ONNX_URL}" "${LAMA_ONNX_SHA256}" /opt/model/lama.onnx \
 && rm /tmp/fetch_model.py

COPY app.py auth.py handler.py inpaint.py ${LAMBDA_TASK_ROOT}/

# `inpaint.model_path()` reads this and refuses to load anything if it is
# unset, so the deployment says where the model is rather than the code
# assuming it.
ENV LAMA_ONNX=/opt/model/lama.onnx

# 0 means "ask the machine", which on Lambda is the vCPU count the configured
# memory buys. Left overridable so a deployment can trade throughput for
# predictable latency without a rebuild.
ENV LAMA_THREADS=0

CMD ["handler.handler"]
