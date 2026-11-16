# DRAFT: Data-usage inquiry to the Government Lottery Office

> **Status: DRAFT. NOT SENT.** A project maintainer must review this, fill in the placeholders and send it personally.
> Recipient (from the gdcatalog dataset `dataset_c4-9_01` maintainer field): `callcenter@glo.or.th`
>
> **Public launch is blocked until GLO replies in writing.** Local development and testing with archived fixtures may continue.

---

**Subject:** ขอสอบถามเงื่อนไขการใช้ข้อมูลผลการออกรางวัลสลากกินแบ่งรัฐบาล (ชุดข้อมูล dataset_c4-9_01) / Inquiry on permitted use of lottery result data

เรียน สำนักเทคโนโลยีสารสนเทศ สำนักงานสลากกินแบ่งรัฐบาล

ข้าพเจ้า [ชื่อผู้ติดต่อ] ในนามโครงการ [ชื่อโครงการ] กำลังพัฒนาเว็บไซต์และ REST API **เพื่อการให้ข้อมูลเท่านั้น** สำหรับแสดงผลการออกรางวัลสลากกินแบ่งรัฐบาล ค้นดูผลย้อนหลัง และตรวจผลรางวัล โดย **ไม่มี** การจำหน่ายสลาก การรับแทง การชำระเงิน หรือการโฆษณาใด ๆ

ข้าพเจ้าพบชุดข้อมูล "ข้อมูลผลการออกรางวัลสลากกินแบ่งรัฐบาล" (dataset_c4-9_01) บน gdcatalog.glo.or.th ซึ่งระบุสัญญาอนุญาต "Creative Commons Non-Commercial (Any)" และ API ที่เผยแพร่ไว้ (getLatestLottery, getLotteryResult, getcheckLotteryResult) จึงขอเรียนสอบถามดังนี้

1. สัญญาอนุญาตที่ใช้คือ Creative Commons รุ่นใด (เช่น CC BY-NC 4.0) และครอบคลุมทั้งข้อมูลผลรางวัล ไฟล์ PDF และวิดีโอหรือไม่
2. อนุญาตให้นำผลรางวัลไปแสดงบนเว็บไซต์ และให้บริการผ่าน API สาธารณะแบบอ่านอย่างเดียว (ไม่คิดค่าบริการ) ได้หรือไม่
3. ต้องการให้ระบุแหล่งที่มา (attribution) ในรูปแบบใด
4. มีข้อจำกัดอัตราการเรียกใช้ API (rate limit) หรือเงื่อนไขการใช้งานทางเทคนิคที่ควรปฏิบัติหรือไม่ เราวางแผนเรียกไม่เกิน 1 ครั้งต่อ 5 วินาที เฉพาะช่วงวันออกรางวัล
5. การนำเข้าข้อมูลย้อนหลังครั้งเดียว (ประมาณ 400–700 คำขอ ในช่วงเวลาที่มีผู้ใช้น้อย) เป็นที่ยอมรับหรือไม่ หรือมีช่องทางดาวน์โหลดข้อมูลย้อนหลังทั้งหมดที่แนะนำ
6. ข้อมูลจำนวนเงินรางวัล (price) ของงวดในอดีต เป็นจำนวนเงินที่จ่ายจริงในงวดนั้นหรือไม่
7. หากมีการแก้ไขผลรางวัลภายหลัง สำนักงานฯ ประกาศผ่านช่องทางใด

ขอขอบพระคุณเป็นอย่างสูง

[ชื่อ] / [อีเมลติดต่อ] / [URL โครงการ (ถ้ามี)]

---

**English version (same content)**

Dear GLO Information Technology Bureau,

I am [contact name], writing on behalf of [project name]. We are building an **informational-only** website and read-only REST API that shows Thai Government Lottery results, lets people browse past draws and lets them check their numbers. It involves **no** ticket sales, betting, payments or advertising.

We found the dataset "ข้อมูลผลการออกรางวัลสลากกินแบ่งรัฐบาล" (`dataset_c4-9_01`) on gdcatalog.glo.or.th. It is labelled "Creative Commons Non-Commercial (Any)" and documents the getLatestLottery, getLotteryResult and getcheckLotteryResult APIs. We would be grateful for answers to the following:

1. Which Creative Commons licence version applies (for example CC BY-NC 4.0)? Does it also cover the result PDFs and draw videos?
2. May we display the results on our website and re-serve them through a free, read-only public API?
3. What attribution wording do you require?
4. Are there rate limits or technical usage conditions? We plan to make at most 1 request every 5 seconds, and only around draw times.
5. Is a one-time historical backfill acceptable (about 400–700 requests, made off-peak)? Or is there a preferred bulk download?
6. Are the `price` values for past draws the amounts actually paid at the time of each draw?
7. How does GLO announce corrections to published results?

Thank you very much.

[Name] / [contact email] / [project URL, if any]
