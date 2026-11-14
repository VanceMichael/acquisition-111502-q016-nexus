# 来源资料契约

支持 TAXA、CHARACTERS/DATA、SETS、TREES 的来源声明，保留未知命令；block 对分类单元的链接按 TITLE/LINK 和唯一上下文解释，歧义不猜。character-state 的 value 含 taxon、character（1起）、kind（value/missing/gap/polymorphic/uncertain）、states；MATCHCHAR 引用同列参考分类单元，原 token 也保存。tree-leaf 使用 tree、token、taxon，TRANSLATE 仅影响本 TREES block。注释可嵌套，引号标签与分号文本不能用简单 split 切开。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。
