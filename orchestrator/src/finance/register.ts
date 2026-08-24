/**
 * 金融行业包的**注册入口**。任何会走到数字忠实度校验的进程,都必须先 import 这一行。
 *
 * 这是 Core + DomainPack 边界的第一块砖:Core(`number_fidelity.ts`)不再内联行业词表,
 * 改为接受注入;金融词表落在 `finance/`。以后 DomainPack 契约完善后,这里会扩展成注册
 * stages / schemas / validators / reportSections 的完整入口。
 */
import { setDomainLexicon } from "../number_fidelity.ts";
import { FINANCE_LEXICON } from "./lexicon.ts";

setDomainLexicon(FINANCE_LEXICON);
export { FINANCE_LEXICON };
