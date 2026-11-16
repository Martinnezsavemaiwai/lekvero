import { PRIZE_CATEGORIES, PRIZE_STRUCTURES } from '@lekvero/shared';

export default function HomePage() {
  const categories = Object.values(PRIZE_CATEGORIES).sort((a, b) => a.sortOrder - b.sortOrder);
  const modern = PRIZE_STRUCTURES.MODERN_FRONT3_BACK3.expectedCounts;
  return (
    <main>
      <h1>Lekvero</h1>
      <p>Development preview. Lottery results are not published yet (see project roadmap).</p>
      <h2>ประเภทรางวัล / Prize categories</h2>
      <ul>
        {categories.map((c) => (
          <li key={c.code}>
            {c.nameTh} — {c.nameEn} ({modern[c.code] ?? 0} × {c.digits}-digit)
          </li>
        ))}
      </ul>
    </main>
  );
}
