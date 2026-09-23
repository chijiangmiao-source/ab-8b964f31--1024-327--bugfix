// 八组双元基本事件示例（A0/B0 … A7/B7）：
// 每组一个“至少一个发生”的 OR 门 Oi 与一个“两个同时发生”的 AND 门 Di；
// 汇总门 SUM 汇集八个双事件 AND 门；顶门 TOP 同时引用八个单组 OR 门与 SUM。
// 正确结论：8 × 2^7 = 1024 个极小割集，每个割集恰含 9 个事件；16 个事件全部可选。
export const SAMPLE_EVENTS = `# 每行一个基本事件（2-30 个，ASCII 标识）
A0
B0
A1
B1
A2
B2
A3
B3
A4
B4
A5
B5
A6
B6
A7
B7
`;

export const SAMPLE_GATES = `# 每行：门名 AND|OR 输入...（输入可为基本事件或其他门）
# 八组单组 OR 门：组内至少一个事件发生
O0 OR A0 B0
O1 OR A1 B1
O2 OR A2 B2
O3 OR A3 B3
O4 OR A4 B4
O5 OR A5 B5
O6 OR A6 B6
O7 OR A7 B7
# 八组双事件 AND 门：组内两个事件同时发生
D0 AND A0 B0
D1 AND A1 B1
D2 AND A2 B2
D3 AND A3 B3
D4 AND A4 B4
D5 AND A5 B5
D6 AND A6 B6
D7 AND A7 B7
# 汇总门：八组中至少有一组两个事件同时发生
SUM OR D0 D1 D2 D3 D4 D5 D6 D7
# 顶事件：八组各至少一个发生，且至少一组两个同时发生
TOP AND O0 O1 O2 O3 O4 O5 O6 O7 SUM
`;

export const SAMPLE_TOP = 'TOP';
