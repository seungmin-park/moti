# 실제 상품 페이지 사진 복사 확인 (3b)

2026-11-12T13:02Z, 로컬 macOS(Apple Silicon)에서 `node scripts/check-real-pages.mjs <url...>`로 실행했다. 3a와 같은 10개 주소다. 페이지는 운영 앱과 같은 엄격한 주소 정책·크기·시간 제한으로 읽고, 사진은 운영 앱과 같은 이미지 요청(출처만 Referer로 보냄, 8 MiB, 10초), 바이트 판별, sharp 정규화를 거친다. 이 확인은 Storage에 올리지 않는다. 정규화까지 성공하면 실행이 저장할 사본을 `copied`로 적는다. 차단은 통과로 세지 않는다.

| 쇼핑몰 | 페이지 | 이름·가격 | 사진 주소의 호스트 | 사진 결과 |
| --- | --- | --- | --- | --- |
| 29CM | ok | 있음·KRW 89000 | img.29cm.co.kr | copied. WebP 32 KiB → WebP 1000×1000 30 KiB |
| 오늘의집 | ok | 있음·KRW 125000 | image.ohousecdn.com | copied. JPEG 430 KiB → WebP 1200×1200 130 KiB |
| 11번가 | ok | 있음·KRW 6900 | cdn.011st.com | copied. WebP 10 KiB → WebP 600×600 11 KiB |
| IKEA(한국) | ok | 있음·KRW 69900 | www.ikea.com | copied. AVIF 33 KiB → WebP 1200×1200 20 KiB |
| Apple(한국) | ok | 있음·KRW 49000 | store.storeimages.cdn-apple.com | copied. JPEG 53 KiB → WebP 1200×630 9 KiB |
| Amazon | ok | 이름만 | 없음 | absent. 구조화 데이터와 Open Graph에서 사진 주소를 찾지 못했다 |
| 무신사 | no_product_data | 없음 | (image.msscdn.net) | 시도하지 않음. 페이지에서 상품 이름을 찾지 못해 수집이 실패로 끝난다 |
| 쿠팡 | blocked_by_site(4xx) | 없음 | - | 시도하지 않음 |
| SSG | blocked_by_site(4xx) | 없음 | - | 시도하지 않음 |
| 올리브영 | blocked_by_site(4xx) | 없음 | - | 시도하지 않음 |

- 사진을 받은 다섯 곳 모두 출처만 담은 Referer로 핫링크 차단 없이 받았다. 사진 요청이 거절된 곳은 없었다.
- 원본 형식은 WebP 2곳, JPEG 2곳, AVIF 1곳이다. AVIF는 libvips가 `heif`로 읽고 판별 결과와 맞는지 확인한 뒤 다시 인코딩했다.
- 저장할 사본은 모두 1 MiB 한도보다 훨씬 작다(최대 130 KiB).
- 11번가 가격은 3a 확인 때 KRW 15800이었고 이번에는 KRW 6900이다. 페이지 데이터가 바뀐 것으로 보며 어느 값이 결제가인지는 확인하지 않았다.
- 무신사의 사진 주소는 페이지 메타데이터에 있지만 이름이 없어 수집 자체가 실패한다. 3b는 이 동작을 바꾸지 않는다.
- 차단된 세 곳과 무신사는 링크를 보존하고 다시 가져오기를 제공한다. 사진은 중립 자리표시로 보인다.
- 이 확인은 Storage 업로드, 서명 주소, 실제 화면 표시를 포함하지 않는다. 그 경로는 로컬 실제 스택의 service·HTTP·브라우저 검사가 대신 쇼핑몰로 확인했다.

원본 출력:

```text
host=www.29cm.co.kr	outcome=ok	status=2xx	title="'곡'니트-베이지"	price=KRW:89000(minor)	imageHost=img.29cm.co.kr	image=copied(webp 32KiB -> webp 1000x1000 30KiB)
host=ohou.se	outcome=ok	status=2xx	title="플로렌 라탄 바스켓 테이블 트리"	price=KRW:125000(minor)	imageHost=image.ohousecdn.com	image=copied(jpeg 430KiB -> webp 1200x1200 130KiB)
host=www.11st.co.kr	outcome=ok	status=2xx	title="[네이처리퍼블릭] 진짜진짜 촉촉한 올리브 기초세트 (각 180ml)"	price=KRW:6900(minor)	imageHost=cdn.011st.com	image=copied(webp 10KiB -> webp 600x600 11KiB)
host=www.ikea.com	outcome=ok	status=2xx	title="VAPPEBY Bluetooth speaker - white/gen 3 20x20 cm"	price=KRW:69900(minor)	imageHost=www.ikea.com	image=copied(avif 33KiB -> webp 1200x1200 20KiB)
host=www.apple.com	outcome=ok	status=2xx	title="AirTag"	price=KRW:49000(minor)	imageHost=store.storeimages.cdn-apple.com	image=copied(jpeg 53KiB -> webp 1200x630 9KiB)
host=www.amazon.com	outcome=ok	status=2xx	title="Amazon.com: Amazon Kindle Paperwhite 16GB(최신 모델) - 20% 더 빠름, 7인치 눈부심 없는 디스플레이 및 몇 주 동안 배터리 수명 - 블랙 + 3개월 킨들 언리미티드 (자동 갱신"	price=none	imageHost=-	image=absent
host=www.musinsa.com	outcome=no_product_data	status=2xx	title=-	price=none	imageHost=image.msscdn.net	image=-
host=www.coupang.com	outcome=blocked_by_site	status=4xx	title=-	price=-	image=-
host=www.ssg.com	outcome=blocked_by_site	status=4xx	title=-	price=-	image=-
host=www.oliveyoung.co.kr	outcome=blocked_by_site	status=4xx	title=-	price=-	image=-
```

사용한 주소는 [3a 기록](../metadata/real-pages.md)과 같다.
