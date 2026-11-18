# 来源资料契约

支持 TAXA、CHARACTERS/DATA、SETS、TREES 的来源声明，保留未知命令；block 对分类单元的链接按 TITLE/LINK 和唯一上下文解释，歧义不猜。character-state 的 value 含 taxon、character（1起）、kind（value/missing/gap/polymorphic/uncertain/matchchar）、states、originalToken；MATCHCHAR 引用同列参考分类单元，原 token 也保存，参考列不是可继承状态时保留 matchchar 并登记 matchchar_unresolved，绝不以上一行字符补缺失。tree-leaf 使用 tree、token、taxon、translated，TRANSLATE 仅影响本 TREES block。注释可嵌套，引号标签与分号文本不能用简单 split 切开。

结构化记录种类：taxon（分类单元声明）、character（字符声明，1 起编号）、format（DATATYPE/GAP/MISSING/MATCHCHAR/INTERLEAVE/TOKENS/SYMBOLS 来源声明）、charset（SETS 分区，含结构化 elements 与原文 raw）、translate（本 TREES block 的 token→taxon 表）、tree（树声明，rooting 只取来源 [&R]/[&U]，无声明为 unspecified，并保留 newick 原文）、tree-leaf、character-state，以及 unknown-command（supported:false，整段保留原文）。交错矩阵按物理行分段并按分类单元接续重组；GAP、MISSING、多态 ()、不确定 {} 分别成类。截断的 TREE 等未终止命令不产生半截记录，登记 unterminated_command，已完整的 block 仍正常解释。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。issues 每项含 reason、location 与可选 detail/provenance，至少能说明原因、受影响范围和已有来源依据，不能用静默丢弃表示未知。缺失资料不等于来源明确删除。本服务不推断系统发育关系，也不评价树的优劣；树的有根性仅复述来源声明。
