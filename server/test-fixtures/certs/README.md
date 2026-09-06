# cluster-certs 测试夹具

自签测试证书(仅测试用,不是任何真实环境的凭据)。Node 无法签发 X509,openssl 是唯一来源。
再生成:`sh gen.sh`(须 openssl ≥ 1.1.1)。指纹/日期会变,测试断言从解析结果推导,不依赖具体值。

- ca1.pem:测试根 CA 1;leaf1.pem:ca1 签发的叶子证书(CN=api.demo.local,SAN 见 gen.sh)
- ca2.pem:测试根 CA 2(与 ca1 无关,用于 CA 失配用例)
