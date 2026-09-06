#!/bin/sh
# 再生成 cluster-certs 测试夹具(Node 无法签发 X509,openssl 是唯一来源)。
# 有效期 3650 天;测试断言从解析出的日期推导(注入 now),不硬编码绝对日期 → 再生成不破坏测试。
set -e
cd "$(dirname "$0")"
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca1.key -out ca1.pem -days 3650 -subj "/CN=AB Test Root CA 1/O=AliangBoard Fixtures"
openssl req -newkey rsa:2048 -nodes -keyout leaf1.key -out leaf1.csr -subj "/CN=api.demo.local/O=AliangBoard Fixtures"
printf "subjectAltName=DNS:api.demo.local,DNS:k8s.demo.local,IP:127.0.0.1\n" > leaf1.ext
openssl x509 -req -in leaf1.csr -CA ca1.pem -CAkey ca1.key -CAcreateserial -out leaf1.pem -days 3650 -extfile leaf1.ext
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca2.key -out ca2.pem -days 3650 -subj "/CN=AB Test Root CA 2/O=AliangBoard Fixtures"
rm -f leaf1.csr leaf1.ext ca1.srl
