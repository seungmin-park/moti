import { expect, type Locator } from "@playwright/test";

export async function expectNeutral(locator: Locator, properties: string[]) {
  const colors = await locator.evaluate((element, names) => {
    const style = getComputedStyle(element);
    return names.map((name) => style.getPropertyValue(name));
  }, properties);
  for (const color of colors) {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    expect(channels, color).toHaveLength(3);
    expect(
      Math.max(...channels!) - Math.min(...channels!),
      color,
    ).toBeLessThanOrEqual(1);
  }
}
