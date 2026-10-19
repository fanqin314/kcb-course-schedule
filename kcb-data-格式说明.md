# kcb-data.js · 校历插件数据格式说明

本文件描述 `kcb-data.js` 的标准结构，供**用户把课表页复制的 HTML 交给 AI 后，让 AI 自动生成一个合法的 `kcb-data.js`**。

> 放到与 `课程表.html` 同目录即生效；删除它则回退到 HTML 内嵌的内置校历，不影响运行。

---

## 一、给 AI 的一句话任务

> 你是一个课表数据转换器。请根据【数据格式规范】和用户提供的【课表 HTML】，把其中的课程逐一解析为 `courses` 数组里的对象，并输出完整的 `kcb-data.js` 文件内容（包含 `window.KCB_DATA`）。若某字段在 HTML 中无法确定，给出合理默认；并说明你都做了哪些推测。

用户把这句话连同【本格式文档】和【复制的 HTML】一起交给 AI 即可。

---

## 二、文件整体结构

`kcb-data.js` 是一个自执行函数，把数据挂到 `window.KCB_DATA`：

```js
(function (g) {
    g.KCB_DATA = {

        courses: [ /* 课程数组，见下 */ ],

        semester_start: '2026-08-31',   // 开学日期，'YYYY-MM-DD'，当天视为第 1 周周一
        max_week: 18,                   // 学期总周数（正整数）

        normal_times: { /* 普通作息 */ },
        special_pm_times: { /* 特殊下午作息（可选） */ },
        period_labels: [ /* 上下午/晚上分组 */ ]

    };
})(window);
```

---

## 三、courses（课程数组）

每门课是一个对象，字段如下：

| 字段 | 类型 | 含义 | 示例 |
|------|------|------|------|
| `day` | number | 星期几，**1=周一 … 7=周日** | `1` |
| `start` | number | 起始节次（第几节开始，1-10） | `3` |
| `span` | number | 连续节数 | `2` |
| `name` | string | 课程名称 | `"高等数学"` |
| `teacher` | string | 教师姓名（可空串） | `"李老师"` |
| `room` | string | 教室/地点 | `"A203"` |
| `weeks` | string | 周次串，语法见下 | `"2-4,6,8-16"` |

**`day` 与 `start`/`span` 说明**

- 数组里某元素如果该天没有课，就**不要**往 `courses` 里加对象（缺省即无课）。
- `day` 必须能对应到课表 HTML 的列（通常是周一~周日的第 2~8 列）。
- `start`/`span` 对应 HTML 的行位置：某节课所在行号 = `start`；若某天同一门课在表格中跨多行，则 `span` = 跨行数。

**`weeks`（周次串）语法**（与课程表应用内置解析一致）

- 用英文逗号 `,` 分隔多个片段。
- 片段形式：
  - 单个周：`8`
  - 连续区间：`2-16`
  - 区间/单周后跟 **单**（奇周）或 **双**（偶周）：`7-17单`、`2-18双`、`3` 配 `单` 等
- 合法示例：`"11-12"`、`"2-4,6,8-16"`、`"2-18双"`、`"3,7-17单"`。
- 若要该课**每周都上**，写 `"1-18"`（max_week 是多少就写到多少）。
- 空字符串 `""` 表示该课不排任何周（通常用不到）。

**解析时的推测规则（对 AI）**

1. 若 HTML 单元格里同一格子出现多行（课程名、教师、教室、周次等以换行/`<br>`/空格分隔），按"名称 / 教师 / 教室"顺序猜测；`name` 取最像课程名的那个，其余尽量分布到 `teacher`/`room`。
2. 若 HTML 无周次信息，默认 `"1-18"`，并在结果注释里注明。
3. 若 HTML 无教师，`teacher` 写 `""`。
4. `start`/`span` 严格按行号/跨行数换算，不要臆造。

---

## 四、作息时间 normal_times 与 special_pm_times

键是**节次数字**（1 到 10），值 `{ start, end }`，时间为 24 小时制字符串（秒可省略）：

```js
normal_times: {
    1: { start: '8:20', end: '9:05' },
    2: { start: '9:15', end: '10:00' },
    3: { start: '10:30', end: '11:15' },
    4: { start: '11:25', end: '12:10' },
    5: { start: '14:30', end: '15:15' },
    6: { start: '15:25', end: '16:10' },
    7: { start: '16:40', end: '17:25' },
    8: { start: '17:35', end: '18:20' },
    9: { start: '19:20', end: '20:05' },
    10: { start: '20:15', end: '21:00' }
}
```

`special_pm_times`（**可选，没有可写 `{}`**）用于特殊下午作息（如周五、周六下午提前上课）。键同样是节次数字：

```js
special_pm_times: {
    5: { start: '13:10', end: '13:55' },
    6: { start: '14:05', end: '14:50' },
    7: { start: '15:20', end: '16:05' },
    8: { start: '16:15', end: '17:00' }
}
```

> 注：应用只会对周五、周六的下午节次套用 `special_pm_times`，其余按 `normal_times`。**不要**把特殊时段合并进 `normal_times`，否则会造成普通日课表出现多余时间空隙。

---

## 五、period_labels（上下午/晚上分组）

决定「上午/下午/晚上」三个区块的标题、图标与包含哪些节次。`icon` 取值固定为 `'sun'` / `'cloud_sun'` / `'moon'`（未知值会自动回退太阳图标）：

```js
period_labels: [
    { label: '上午', icon: 'sun', periods: [1, 2, 3, 4] },
    { label: '下午', icon: 'cloud_sun', periods: [5, 6, 7, 8] },
    { label: '晚上', icon: 'moon', periods: [9, 10] }
]
```

要求：所有 `periods` 相加应覆盖 1~10 的全部节次，且互不重叠。

---

## 六、完整示例（可直接用作模板）

```js
(function (g) {
    g.KCB_DATA = {
        courses: [
            { day: 1, start: 1, span: 2, name: '高等数学', teacher: '李老师', room: 'A203', weeks: '1-16' }
        ],
        semester_start: '2026-08-31',
        max_week: 18,
        normal_times: {
            1: { start: '8:20', end: '9:05' }, 2: { start: '9:15', end: '10:00' },
            3: { start: '10:30', end: '11:15' }, 4: { start: '11:25', end: '12:10' },
            5: { start: '14:30', end: '15:15' }, 6: { start: '15:25', end: '16:10' },
            7: { start: '16:40', end: '17:25' }, 8: { start: '17:35', end: '18:20' },
            9: { start: '19:20', end: '20:05' }, 10: { start: '20:15', end: '21:00' }
        },
        special_pm_times: {},
        period_labels: [
            { label: '上午', icon: 'sun', periods: [1, 2, 3, 4] },
            { label: '下午', icon: 'cloud_sun', periods: [5, 6, 7, 8] },
            { label: '晚上', icon: 'moon', periods: [9, 10] }
        ]
    };
})(window);
```

---

## 七、校验清单（生成后自查）

- [ ] `courses` 里每个对象都含 `day/start/span/name/teacher/room/weeks` 七个字段。
- [ ] `day` 是 1~7；`start` 是 1~10；`span ≥ 1`；且 `start + span - 1 ≤ 10`。
- [ ] `weeks` 只有 `,` `-` `单` `双` 和数字，没有其它符号。
- [ ] `semester_start` 是 `'YYYY-MM-DD'`；`max_week` 是正整数。
- [ ] `normal_times` 覆盖用到的所有节次；精度到分钟。
- [ ] `period_labels` 覆盖 1~10 且不重叠。
- [ ] 整体能作为一个合法的 `.js`，内容以 `(function (g) {` 开头、以 `})(window);` 结尾。