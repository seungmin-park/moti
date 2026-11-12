# 실제 상품 페이지 수집 확인 (3a)

2026-11-11, 로컬 macOS에서 `node scripts/check-real-pages.mjs <url...>`로 실행했다. 운영 앱과 같은 엄격한 주소 정책·크기·시간 제한을 쓴다. 상품 주소는 웹 검색으로 찾은 실제 상품 페이지다. 차단은 통과로 세지 않는다.

| 쇼핑몰 | 결과 | 상태 | 이름 | 가격 |
| --- | --- | --- | --- | --- |
| 29CM | ok | 2xx | '곡'니트-베이지 | KRW 89000 |
| 오늘의집 | ok | 2xx | 플로렌 라탄 바스켓 테이블 트리 | KRW 125000 |
| 11번가 | ok | 2xx | [네이처리퍼블릭] 진짜진짜 촉촉한 올리브 기초세트 (각 180ml) | KRW 15800 |
| IKEA(한국) | ok | 2xx | VAPPEBY Bluetooth speaker - white/gen 3 20x20 cm | KRW 69900 |
| Apple(한국) | ok | 2xx | AirTag | KRW 49000 |
| Amazon | ok | 2xx | Amazon.com: Amazon Kindle Paperwhite 16GB(최신 모델) … | 없음(하나로 분명하지 않음) |
| 무신사 | no_product_data | 2xx | - | - |
| 쿠팡 | blocked_by_site | 4xx | - | - |
| SSG | blocked_by_site | 4xx | - | - |
| 올리브영 | blocked_by_site | 4xx | - | - |

- 네이버 스마트스토어는 검색으로 실제 상품 주소를 찾지 못해 확인하지 못했다.
- 무신사는 페이지는 받았지만 구조화 데이터·Open Graph에서 상품 이름을 찾지 못했다. 화면을 스크립트로 그리는 것으로 추정하며 확인하지 않았다.
- 11번가 가격은 페이지 데이터의 값이다. 검색 요약에는 할인가 13,900원이 보였다. 어느 값이 실제 결제가인지는 확인하지 않았다.
- 차단된 곳과 무신사는 링크를 보존하고 실패 이유를 보여준다. 다시 가져오기로 재시도할 수 있다.

사용한 주소:
- https://www.29cm.co.kr/products/746888
- https://ohou.se/productions/1101505/selling
- https://www.11st.co.kr/products/6294046143
- https://www.ikea.com/kr/en/p/vappeby-bluetooth-speaker-white-gen-3-60517383/
- https://www.apple.com/kr/shop/buy-airtag/airtag/1%EA%B0%9C-%ED%8C%A9
- https://www.amazon.com/dp/B0DFYWDGW6
- https://www.musinsa.com/products/3374469
- https://www.coupang.com/vp/products/2074736577
- https://www.ssg.com/item/itemView.ssg?itemId=1000063679111
- https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=A000000190168
