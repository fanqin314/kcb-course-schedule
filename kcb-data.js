/* ================================================================
 * KCB 校历配置插件文件（由 sync_kcb.js 自动生成于 2026/10/26 00:00:25）
 * ----------------------------------------------------------------
 * 数据来源：学校教务系统课表查询页；手动修改会被下次同步覆盖，
 * 如需长期手改，请改用课程表.html 内嵌校历。
 * 用法：与 课程表.html 同目录即生效；删除本文件回退内置校历。
 * ================================================================ */
(function (g) {
    g.KCB_DATA = {
        courses: [
            { day: 1, start: 1, span: 2, name: '美育（非遗）', teacher: '杨晋良', room: 'D304', weeks: '11-12' },
            { day: 1, start: 3, span: 2, name: '工程力学Ⅱ', teacher: '高文', room: 'C306', weeks: '2-4,8-16' },
            { day: 1, start: 5, span: 2, name: '大学英语AⅢ', teacher: '李静', room: '毓秀204', weeks: '2,4,8,10,12,14,16,18' },
            { day: 1, start: 7, span: 2, name: '新能源汽车电工与电子技术Ⅱ', teacher: '周艳梅', room: 'D606', weeks: '9' },
            { day: 1, start: 7, span: 2, name: '大学生心理健康（恋爱心理与防艾）', teacher: '李子嫣', room: '毓秀104', weeks: '17-18' },
            { day: 2, start: 1, span: 2, name: '形势与政策Ⅲ', teacher: '蔡林', room: 'B609', weeks: '8' },
            { day: 2, start: 1, span: 2, name: '大学生创新与创业Ⅰ', teacher: '李洪琴', room: 'D304', weeks: '2-4,6' },
            { day: 2, start: 3, span: 2, name: '大学体育Ⅲ', teacher: '陈苗', room: '操场42', weeks: '9' },
            { day: 2, start: 3, span: 2, name: '大学体育Ⅲ', teacher: '陈苗', room: '操场25', weeks: '8' },
            { day: 2, start: 5, span: 2, name: '毛泽东思想和中国特色社会主义理论体系概论', teacher: '林馨', room: '毓秀205B', weeks: '3,7,9,11,13,15,17' },
            { day: 2, start: 7, span: 2, name: '形势与政策Ⅲ', teacher: '蔡林', room: 'D404', weeks: '9-10' },
            { day: 2, start: 9, span: 2, name: '劳动教育', teacher: '刘璐', room: '毓秀305', weeks: '3,7,9,11,13,15,17' },
            { day: 3, start: 1, span: 2, name: '大学英语AⅢ', teacher: '李静', room: 'D508', weeks: '2-4,8-18' },
            { day: 3, start: 3, span: 2, name: '大学体育Ⅲ', teacher: '陈苗', room: '操场04', weeks: '2-3,8-18' },
            { day: 3, start: 5, span: 2, name: '线性代数', teacher: '李欣', room: 'B302', weeks: '2-4,8-18' },
            { day: 3, start: 7, span: 2, name: '计算机程序设计基础（C语言）', teacher: '郭志庭', room: '汽修103（元宇宙虚拟现实）', weeks: '2,4,6,8-18' },
            { day: 4, start: 1, span: 2, name: '计算机绘图（机械CAD）', teacher: '刘家麟', room: '汽实201（电子仿真）', weeks: '2-4,6,8-18' },
            { day: 4, start: 3, span: 2, name: '新能源汽车电工与电子技术Ⅱ', teacher: '周艳梅', room: 'D510', weeks: '2-4,8-17' },
            { day: 4, start: 3, span: 2, name: '新能源汽车电工与电子技术Ⅱ', teacher: '周艳梅', room: '汽检201', weeks: '6' },
            { day: 4, start: 5, span: 2, name: '大学英语AⅢ', teacher: '李静', room: '钟灵楼（6号楼）310', weeks: '6' },
            { day: 4, start: 7, span: 2, name: '工程力学Ⅱ', teacher: '高文', room: 'C306', weeks: '3,9,11,13,15' },
            { day: 4, start: 9, span: 2, name: '工程力学Ⅱ', teacher: '高文', room: 'C406', weeks: '6' },
            { day: 5, start: 1, span: 2, name: '毛泽东思想和中国特色社会主义理论体系概论', teacher: '林馨', room: '毓秀201', weeks: '2-4,6-18' },
            { day: 5, start: 3, span: 2, name: '新能源汽车电工与电子技术Ⅱ', teacher: '周艳梅', room: 'D301', weeks: '2-3,8-17' },
            { day: 5, start: 3, span: 2, name: '新能源汽车电工与电子技术Ⅱ', teacher: '周艳梅', room: '汽检201', weeks: '6' },
            { day: 5, start: 5, span: 2, name: '大学英语AⅢ', teacher: '李静', room: '毓秀303', weeks: '6' },
            { day: 5, start: 7, span: 2, name: '计算机程序设计基础（C语言）', teacher: '郭志庭', room: '汽修103（元宇宙虚拟现实）', weeks: '3' },
            { day: 6, start: 1, span: 2, name: '形势与政策Ⅲ', teacher: '蔡林', room: 'D404', weeks: '6' },
            { day: 6, start: 5, span: 2, name: '线性代数', teacher: '李欣', room: 'B303', weeks: '6' },
            { day: 6, start: 7, span: 2, name: '大学物理实验', teacher: '后爱强', room: 'A203', weeks: '2-4,6,8-18' },
        ],
        semester_start: '2026-08-31',
        max_week: 20,
        normal_times: {
            1: { start: '8:20', end: '9:05' }, 2: { start: '9:15', end: '10:00' },
            3: { start: '10:30', end: '11:15' }, 4: { start: '11:25', end: '12:10' },
            5: { start: '14:00', end: '14:45' }, 6: { start: '14:55', end: '15:40' },
            7: { start: '16:10', end: '16:55' }, 8: { start: '17:05', end: '17:50' },
            9: { start: '19:00', end: '19:45' }, 10: { start: '19:55', end: '20:40' }
        },
        special_pm_times: {
            5: { start: '13:10', end: '13:55' }, 6: { start: '14:05', end: '14:50' },
            7: { start: '15:20', end: '16:05' }, 8: { start: '16:15', end: '17:00' }
        },
        period_labels: [
            { label: '上午', icon: 'sun', periods: [1, 2, 3, 4] },
            { label: '下午', icon: 'cloud_sun', periods: [5, 6, 7, 8] },
            { label: '晚上', icon: 'moon', periods: [9, 10] },
        ]
    };
})(window);
