/* ================================================================
 * KCB 校历配置插件文件（可选 / 可拔插）
 * ----------------------------------------------------------------
 * 放一个与 课程表.html 同目录，加载 HTML 时自动生效。
 * 删除本文件 = 回退到 HTML 内嵌的默认校历。想给别的学校/学期用，
 * 只需改这里的课程、开学日、周数、作息与节次分组即可。
 * 数据格式说明：
 *   courses      课程：{ day:1-7, start:起始节, span:连续节数,
 *                       name, teacher, room, weeks:'2-4,6,8-16' 或 '2-18单' }
 *   semester_start  开学日期，'YYYY-MM-DD'（当天属于第 1 周周一）
 *   max_week        学期总周数
 *   normal_times    普通作息，第 10 节封顶
 *   special_pm_times 特殊下午作息（周五/周六下午）+ 节点可选不填
 *   period_labels   上下午/晚上分组：icon 支持 'sun'|'cloud_sun'|'moon'
 * ================================================================ */
(function (g) {
    g.KCB_DATA = {
        courses: [
            { day: 1, start: 1, span: 2, name: '美育（非遗）', teacher: '杨晋良', room: 'D304', weeks: '11-12' },
            { day: 1, start: 3, span: 2, name: '工程力学Ⅱ', teacher: '高文', room: 'C306', weeks: '2-4,6,8-16' },
            { day: 1, start: 5, span: 2, name: '大学英语AⅢ', teacher: '李静', room: '毓秀204', weeks: '2-18双' },
            { day: 1, start: 7, span: 2, name: '大学生心理健康（恋爱心理与防艾）', teacher: '李子嫣', room: '毓秀104', weeks: '17-18' },
            { day: 2, start: 1, span: 2, name: '大学生创新与创业Ⅰ', teacher: '李洪琴', room: 'D304', weeks: '2-4,6' },
            { day: 2, start: 5, span: 2, name: '毛泽东思想和中国特色社会主义理论体系概论', teacher: '林馨', room: '毓秀205B', weeks: '3,7-17单' },
            { day: 2, start: 7, span: 2, name: '形势与政策Ⅲ', teacher: '蔡林', room: 'D404', weeks: '7-10' },
            { day: 2, start: 9, span: 2, name: '劳动教育', teacher: '刘璐', room: '毓秀305', weeks: '3,7-17单' },
            { day: 3, start: 1, span: 2, name: '大学英语AⅢ', teacher: '李静', room: 'D508', weeks: '2-4,6,8-18' },
            { day: 3, start: 3, span: 2, name: '大学体育Ⅲ', teacher: '陈苗', room: '操场04', weeks: '2-4,6,8-18' },
            { day: 3, start: 5, span: 2, name: '线性代数', teacher: '李欣', room: 'B302', weeks: '2-4,6,8-18' },
            { day: 3, start: 7, span: 2, name: '计算机程序设计基础（C语言）', teacher: '郭志庭', room: '汽实202', weeks: '2-4,6,8-18' },
            { day: 4, start: 1, span: 2, name: '计算机绘图（机械CAD）', teacher: '刘家麟', room: '汽实201', weeks: '2-4,6,8-18' },
            { day: 4, start: 3, span: 2, name: '新能源汽车电工与电子技术Ⅱ', teacher: '周艳梅', room: 'D510', weeks: '2-4,6,8-17' },
            { day: 4, start: 7, span: 2, name: '工程力学Ⅱ', teacher: '高文', room: 'C306', weeks: '3,9-15单' },
            { day: 5, start: 1, span: 2, name: '毛泽东思想和中国特色社会主义理论体系概论', teacher: '林馨', room: '毓秀201', weeks: '2-4,6-18' },
            { day: 5, start: 3, span: 2, name: '新能源汽车电工与电子技术Ⅱ', teacher: '周艳梅', room: 'D301', weeks: '2-4,6,8-17' },
            { day: 6, start: 7, span: 2, name: '大学物理实验', teacher: '后爱强', room: 'A203', weeks: '2-4,6,8-18' }
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
        special_pm_times: {
            5: { start: '13:10', end: '13:55' }, 6: { start: '14:05', end: '14:50' },
            7: { start: '15:20', end: '16:05' }, 8: { start: '16:15', end: '17:00' }
        },
        period_labels: [
            { label: '上午', icon: 'sun', periods: [1, 2, 3, 4] },
            { label: '下午', icon: 'cloud_sun', periods: [5, 6, 7, 8] },
            { label: '晚上', icon: 'moon', periods: [9, 10] }
        ]
    };
})(window);