import sharp from "sharp";

export type VouchCardInput = {
  displayName: string;
  username: string;
  feedback: string;
  submittedAt: Date;
};

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapText(value: string, width: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const nextLine = line ? `${line} ${word}` : word;
    if (nextLine.length > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = nextLine;
    }
  }

  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    const lastLine = lines[maxLines - 1] ?? "";
    lines[maxLines - 1] = `${lastLine.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
  }

  return lines;
}

export async function createVouchCard(input: VouchCardInput): Promise<Buffer> {
  const displayName = escapeXml(input.displayName.slice(0, 40));
  const username = escapeXml(`@${input.username.slice(0, 32)}`);
  const feedbackLines = wrapText(input.feedback.slice(0, 320), 55, 4);
  const feedbackSvg = feedbackLines
    .map(
      (line, index) =>
        `<text x="92" y="${326 + index * 48}" class="feedback">${escapeXml(line)}</text>`,
    )
    .join("");
  const submittedDate = escapeXml(
    input.submittedAt.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }),
  );

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#151228"/>
          <stop offset="100%" stop-color="#080b16"/>
        </linearGradient>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#a78bfa"/>
          <stop offset="100%" stop-color="#67e8f9"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="675" rx="38" fill="url(#bg)"/>
      <rect x="28" y="28" width="1144" height="619" rx="28" fill="none" stroke="#34314d" stroke-width="2"/>
      <rect x="64" y="62" width="9" height="76" rx="5" fill="url(#accent)"/>
      <text x="96" y="99" class="brand">CocoX.wtf</text>
      <text x="96" y="132" class="eyebrow">COMMUNITY VOUCH</text>
      <rect x="944" y="72" width="188" height="48" rx="24" fill="#172b2d" stroke="#2f7a76" stroke-width="2"/>
      <circle cx="973" cy="96" r="8" fill="#5eead4"/>
      <text x="992" y="103" class="verified">USER SUBMITTED</text>
      <rect x="64" y="174" width="1072" height="352" rx="24" fill="#f8f7fb"/>
      <rect x="64" y="174" width="12" height="352" rx="6" fill="url(#accent)"/>
      <text x="92" y="232" class="label">COMMUNITY FEEDBACK</text>
      ${feedbackSvg}
      <line x1="92" y1="456" x2="1104" y2="456" stroke="#dedbe7" stroke-width="2"/>
      <text x="92" y="496" class="attribution">Submitted by ${displayName}</text>
      <text x="92" y="552" class="handle">${username}</text>
      <text x="1104" y="552" text-anchor="end" class="date">${submittedDate}</text>
      <text x="64" y="594" class="footer">Posted by its author in Discord. CocoX.wtf does not create or assign endorsements.</text>
      <style>
        .brand { font: 700 39px Arial, sans-serif; fill: #ffffff; }
        .eyebrow { font: 700 16px Arial, sans-serif; letter-spacing: 4px; fill: #b7afcd; }
        .verified { font: 700 13px Arial, sans-serif; letter-spacing: 1px; fill: #a7f3d0; }
        .label { font: 700 15px Arial, sans-serif; letter-spacing: 2px; fill: #6b6679; }
        .feedback { font: 700 31px Arial, sans-serif; fill: #211d30; }
        .attribution { font: 700 18px Arial, sans-serif; fill: #373247; }
        .handle { font: 600 16px Arial, sans-serif; fill: #716a82; }
        .date { font: 500 15px Arial, sans-serif; fill: #716a82; }
        .footer { font: 500 14px Arial, sans-serif; fill: #938ca7; }
      </style>
    </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
