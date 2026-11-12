import { describe, expect, it } from "vitest";
import { isBlockedAddress, strictFetchPolicy, toFetchTarget } from "./address-policy";

describe("외부 주소 차단표", () => {
  it.each([
    ["0.0.0.0", "현재 네트워크 0/8"], ["0.255.255.255", "현재 네트워크 0/8 끝"],
    ["10.0.0.1", "사설 10/8"], ["10.255.255.255", "사설 10/8 끝"],
    ["100.64.0.1", "CGNAT 100.64/10"], ["100.127.255.255", "CGNAT 100.64/10 끝"],
    ["127.0.0.1", "루프백 127/8"], ["127.255.255.254", "루프백 127/8 끝"],
    ["169.254.169.254", "클라우드 메타데이터 169.254/16"], ["169.254.0.1", "링크 로컬 169.254/16"],
    ["172.16.0.1", "사설 172.16/12"], ["172.31.255.255", "사설 172.16/12 끝"],
    ["192.0.0.1", "IETF 192.0.0/24"], ["192.0.2.1", "문서 192.0.2/24"],
    ["192.88.99.1", "6to4 중계 192.88.99/24"], ["192.168.0.1", "사설 192.168/16"],
    ["198.18.0.1", "벤치마크 198.18/15"], ["198.19.255.255", "벤치마크 198.18/15 끝"],
    ["198.51.100.1", "문서 198.51.100/24"], ["203.0.113.1", "문서 203.0.113/24"],
    ["224.0.0.1", "멀티캐스트 224/4"], ["239.255.255.255", "멀티캐스트 224/4 끝"],
    ["240.0.0.1", "예약 240/4"], ["255.255.255.255", "브로드캐스트"],
  ])("Given IPv4 %s (%s) When 확인하면 Then 막는다", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0",
    "192.0.1.255", "192.88.98.255", "198.17.255.255", "198.20.0.0", "223.255.255.255", "11.0.0.1",
  ])("Given 공인 IPv4 %s When 확인하면 Then 허용한다", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each([
    ["::", "미지정"], ["::1", "루프백"], ["fe80::1", "링크 로컬"], ["fc00::1", "고유 로컬"], ["fd12:3456::1", "고유 로컬"],
    ["ff02::1", "멀티캐스트"], ["64:ff9b::7f00:1", "NAT64 루프백"], ["64:ff9b::808:808", "NAT64 공인"],
    ["64:ff9b:1::1", "로컬 NAT64"], ["2001::1", "Teredo 2001::/23"], ["2001:1ff::1", "2001::/23 끝"],
    ["2001:db8::1", "문서 2001:db8::/32"], ["2002::1", "6to4 2002::/16"], ["2002:7f00:1::", "6to4 루프백"],
    ["3fff::1", "문서 3fff::/20"], ["3fff:fff::1", "3fff::/20 끝"], ["::127.0.0.1", "IPv4 호환"],
    ["::ffff:127.0.0.1", "IPv4 매핑 루프백"], ["::ffff:7f00:1", "16진 IPv4 매핑 루프백"],
    ["::ffff:169.254.169.254", "IPv4 매핑 메타데이터"], ["::ffff:10.0.0.1", "IPv4 매핑 사설"],
    ["4000::1", "2000::/3 밖"], ["not-an-ip", "주소가 아님"], ["", "빈 값"],
  ])("Given %s (%s) When 확인하면 Then 막는다", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["2606:4700:4700::1111", "2404:6800:4004:80a::200e", "2001:200::1", "3ffe::1", "::ffff:8.8.8.8"])(
    "Given 공인 IPv6 %s When 확인하면 Then 허용한다",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe("요청 대상 확인", () => {
  const target = (url: string) => toFetchTarget(new URL(url), strictFetchPolicy);

  it("Given 기본 포트의 도메인 When 확인하면 Then DNS 확인이 필요한 대상이다", () => {
    expect(target("https://shop.example/item")).toEqual({ ok: true, host: "shop.example", port: 443, address: null });
    expect(target("http://shop.example/item")).toEqual({ ok: true, host: "shop.example", port: 80, address: null });
  });

  it("Given 공인 IP 주소 When 확인하면 Then 그 주소로 바로 연결한다", () => {
    expect(target("http://8.8.8.8/")).toEqual({ ok: true, host: "8.8.8.8", port: 80, address: "8.8.8.8" });
    expect(target("https://[2606:4700:4700::1111]/")).toEqual({
      ok: true, host: "2606:4700:4700::1111", port: 443, address: "2606:4700:4700::1111",
    });
  });

  it.each([
    "http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://017700000001/", "http://[::1]/",
    "http://[::ffff:7f00:1]/", "http://[::ffff:127.0.0.1]/", "http://169.254.169.254/latest/meta-data/",
    "http://[64:ff9b::a9fe:a9fe]/", "http://shop.example:8080/", "https://shop.example:8443/", "http://8.8.8.8:22/",
  ])("Given %s When 확인하면 Then 연결 전에 막는다", (url) => {
    expect(target(url)).toEqual({ ok: false, code: "blocked_address" });
  });

  it.each(["ftp://shop.example/", "file:///etc/passwd", "http://user:secret@shop.example/", "http://user@shop.example/"])(
    "Given %s When 확인하면 Then 열 수 없는 주소다",
    (url) => {
      expect(target(url)).toEqual({ ok: false, code: "invalid_url" });
    },
  );
});
