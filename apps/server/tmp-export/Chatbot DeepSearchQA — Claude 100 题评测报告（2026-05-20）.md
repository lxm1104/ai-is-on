# Chatbot DeepSearchQA — Claude 100 题评测报告（2026\-05\-20）

# DeepSearchQA — Claude 100 题评测报告

- 评测集: `evalsets/deepsearch\-qa\-100/full\_cases\.json` \(900 子集, source dataset 7590090982540553218\)

- 答题: claude `\-p` 联网 \(WebSearch/WebFetch/Read\), 并发 6, 单答超时 480s

- 判分: claude agent\_basic \(绕开 validateJudgment 的 category 误毙\)

- 生成: 2026\-05\-20T03:00:29\.800Z

## 总分

<table><tbody>
<tr>
<td>

档位

</td>
<td>

数量

</td>
<td>

占比

</td>
</tr>
<tr>
<td>

通过

</td>
<td>

57

</td>
<td>

57\.0%

</td>
</tr>
<tr>
<td>

部分通过

</td>
<td>

18

</td>
<td>

18\.0%

</td>
</tr>
<tr>
<td>

未通过

</td>
<td>

14

</td>
<td>

14\.0%

</td>
</tr>
<tr>
<td>

执行失败

</td>
<td>

5

</td>
<td>

5\.0%

</td>
</tr>
<tr>
<td>

基本通过

</td>
<td>

1

</td>
<td>

1\.0%

</td>
</tr>
<tr>
<td>

ERROR

</td>
<td>

5

</td>
<td>

5\.0%

</td>
</tr>
<tr>
<td>

**通过类合计**

</td>
<td>

**58**

</td>
<td>

**58%**

</td>
</tr>
</tbody></table>

**pass\_rate = 58\.0%**\(57 通过 \+ 1 基本通过 / 100\);扣 5 个 ERROR 后有效样本 pass = 58/95 ≈ 61\.1%

## ✅ 正确 \(58 题\)

- `DSQA\-0002` \[通过\] There is a MMORPG game that was rumoured to have hit 50k online players after being up for

- `DSQA\-0003` \[通过\] Name the two songs that went viral on TikTok by the artist who \(from 2016 to 2021\) played

- `DSQA\-0004` \[通过\] I\&\#39;d like you to analyze the top five universities in Mexico for 2021\-2022, according to th

- `DSQA\-0006` \[通过\] According to the 2016, 2017, and 2018 Director\&\#39;s Annual Reports published by the Toronto D

- `DSQA\-0001` \[通过\] Consider the OECD countries whose total population was composed of at least 20% of foreign

- `DSQA\-0015` \[通过\] Determine which states had an ACT participation rate of 50% or higher for the graduating c

- `DSQA\-0013` \[通过\] Among Jakks Pacific, Hasbro, Mattel, and Funko which company had the highest debt\-to\-capit

- `DSQA\-0011` \[通过\] I\&\#39;m researching extreme weather in the United States\. Between 2017 and 2021 \(inclusive\), w

- `DSQA\-0012` \[通过\] Which country, based only on data from the year 2014 and found on the official Our World i

- `DSQA\-0019` \[通过\] According to Agriculture and Agri\-food Canada, before 2023, which years had a double digit

- `DSQA\-0017` \[通过\] I went on a three\-day trip, starting in Cape Kiwanda on the first day, traveling to Shosho

- `DSQA\-0014` \[通过\] In the year that featured a volcanic eruption in Iceland causing widespread air\-travel dis

- `DSQA\-0021` \[通过\] I would like you to extract the following information from the Mental Health Commission of

- `DSQA\-0025` \[基本通过\] Which cities/urban areas under SSGA18 with a population of 15,000 or more are within 400km

- `DSQA\-0024` \[通过\] Using www\.gov\.scot can you list me, in order, the 5 Scottish regions that had the highest

- `DSQA\-0027` \[通过\] In the 2019 UK parliamentary election, in Sheffield and Bristol, which candidates received

- `DSQA\-0033` \[通过\] For the states with 2 seats in the U\.S\. House of Representatives following the 2020 Census

- `DSQA\-0030` \[通过\] By using the NHS website for “Shoulder Pain”, which of the possible causes of the conditio

- `DSQA\-0031` \[通过\] How many research chairs did each of these schools gain or lose between the 2008 Re\-alloca

- `DSQA\-0037` \[通过\] I\&\#39;m trying to remember the primary sponsor of a certain bill that I recall being co\-sponso

- `DSQA\-0022` \[通过\] There is an article that begins on page 433 of Volume 47 of Polar Biology \(Springer Nature

- `DSQA\-0026` \[通过\] Find the votes that passed in the US House of Representatives between December 1st 2023 an

- `DSQA\-0041` \[通过\] Using the 2024 World Happiness Report and the US Census Bureau\&\#39;s International Database, w

- `DSQA\-0050` \[通过\] According to SAMHSA\&\#39;s 2019 National Survey on Drug Use and Health, which gender among teen

- `DSQA\-0045` \[通过\] Using information from End Corporal Punishment, identify the countries that banned all cor

- `DSQA\-0051` \[通过\] Narrow the Pulitzer Prize winners for History from the years 1990 to 1995 down to those wh

- `DSQA\-0049` \[通过\] Across the 2020, 2021, and 2022 “Water and Sewerage Companies Environmental Performance As

- `DSQA\-0059` \[通过\] According to 2022 CDC COVID\-19 mortality data, out of the US states with a population abov

- `DSQA\-0058` \[通过\] The last time a Republican won the New York gubernatorial vote what were the names of the

- `DSQA\-0063` \[通过\] Base your response to this prompt on data found at data\.un\.org\. I\&\#39;m focusing on the follow

- `DSQA\-0060` \[通过\] Based on information located on data\.nysed\.gov, consider ny state graduation rate data for

- `DSQA\-0048` \[通过\] Using discogs, find all of Dizzy Gillespie\&\#39;s shellac records that feature John Coltrane; f

- `DSQA\-0055` \[通过\] According to BiggestUSCities\.com\&\#39;s \&\#34;Top 100 Biggest US Cities\&\#34; lists, which city or cities

- `DSQA\-0042` \[通过\] According to the publicly available meeting minutes for the Executive Committee of the Tor

- `DSQA\-0067` \[通过\] Provide a complete list of all countries that have a population over 100 million in 2025,

- `DSQA\-0065` \[通过\] Looking at the New York State Education Department\&\#39;s 4 year graduation outcome data as of

- `DSQA\-0064` \[通过\] What was the first year in which any of the nine artists that formed \&\#34;Group X\&\#34; that exhibi

- `DSQA\-0070` \[通过\] What was the country with the latest year of independence from European colonization, acco

- `DSQA\-0068` \[通过\] I will be doing environmental research at Macquarie University in Australia, and I want to

- `DSQA\-0074` \[通过\] According to the public policy institute of california\&\#39;s 2018 state\-wide survey for the la

- `DSQA\-0073` \[通过\] In August 2023, which days did Jackson, Mississippi see a high temperature of at least 100

- `DSQA\-0077` \[通过\] In the Sheffield city council ward elections on May 5, 2022, which of Fathima Nabeela Mowl

- `DSQA\-0082` \[通过\] I have recently graduated high school and am searching for a college or university to atte

- `DSQA\-0079` \[通过\] According to eia 2022 rankings and data, which states in the top 10 for energy production

- `DSQA\-0078` \[通过\] Of the states with more than 10% foreigners and a population of more than 2 million in Ger

- `DSQA\-0072` \[通过\] According to the CDC, which US states had a death rate due to heart disease \&gt;191\.5, a deat

- `DSQA\-0081` \[通过\] Which of Isabelle Darcy\&\#39;s \(2012\) coauthors on the article \&\#34;Direct Mapping of Acoustics to

- `DSQA\-0080` \[通过\] List all countries from the 2023 IQAir World Air Quality Report that met the WHO annual PM

- `DSQA\-0087` \[通过\] According to global5050\.org COVID\-19 Sex\-Disaggregated Data Tracker, as of September 2022,

- `DSQA\-0088` \[通过\] According to Clemson University variety evaluations, which farm produced the largest peach

- `DSQA\-0089` \[通过\] Which US counties voted McCain, Romney, Clinton, and Biden?

- `DSQA\-0094` \[通过\] Of the top 5 species groups in global aquaculture from the years 2020, 2021, and 2022, acc

- `DSQA\-0092` \[通过\] According to the Australian Antarctic Data Centre’s biodiversity database, which taxonomic

- `DSQA\-0086` \[通过\] From the data in the IZA Global Preferences Survey, which countries met at least two of th

- `DSQA\-0090` \[通过\] Looking at robbery, homicide, and sexual offenses/violations in Toronto and Vancouver inde

- `DSQA\-0097` \[通过\] Which states had alcohol\-impaired\-driving fatality rates per 100 million vehicle miles tra

- `DSQA\-0098` \[通过\] As of December 31, 2019, which U\.S\. states have never: \-Had a woman serve as governor \(ele

- `DSQA\-0099` \[通过\] I\&\#39;m working on a guide for a RPG released on the DS, which was co\-developed in 2007 by Squ

## 🟡 部分通过 \(18 题, 含原因\)

- `DSQA\-0005` **\[部分通过/语义匹配错误\]**

    - 题目: Of the countries that were part of the top 10 countries with the lowest GPI scores in both 2022 and 2023 \(according to Vision of Humanity\),

    - 参考: Austria, Switzerland, Singapore

    - 实答: Iceland, Singapore, Japan

    - 判分依据: 实际答案与标准答案集合不等价：3 项中仅 1 项（Singapore）正确，Austria 和 Switzerland 被Iceland 和 Japan 替换，属于跨数据源交叉筛选时的事实定位错误。

- `DSQA\-0018` **\[部分通过/语义匹配错误\]**

    - 题目: Find the names of the four members of the US women\&\#39;s 3X3 basketball team at the 2020 Olympics\. Find out what their final college team was an

    - 参考: \* Allisha Gray, University of South Carolina, Dawn Staley, Zia Cooke, Aliyah Boston \* Jacquelyn \(Jackie\) Young, Universi

    - 实答: \- Allisha Gray, South Carolina, Dawn Staley, Zia Cooke, Aliyah Boston \- Katie Lou Samuelson, Connecticut, Geno Auriemma, Aaliyah Edwards, Dorka Juhász \- Kelsey

    - 判分依据: 模型未能正确检索 2020 东京奥运 3X3 女篮美国队第四名成员 Jacquelyn \(Jackie\) Young，将另一名 UConn 背景球员 Katie Lou Samuelson 误植其位，并据此连带错误地关联了 Notre Dame 的赛季数据。

- `DSQA\-0020` **\[部分通过/幻觉式成功\]**

    - 题目: In 2023, The World’s 50 Best restaurants as published by William Reed began to officially list restaurants 51\-100 as well\. Name any restaura

    - 参考: Alchemist, Arpege, Hof Van Cleve, Jordnaer, Le Clarence, Nobelhart \&amp; Schmutzig, Restaurant Tim Raue, Schloss Schauenstei

    - 实答: **Germany** \- Nobelhart \&amp; Schmutzig \(Berlin\) \- Restaurant Tim Raue \(Berlin\) \- Tantris \(Munich\) **Austria** \- Steirereck \(Vienna\) **Belgium** \- The Jane \(Antwerp

    - 判分依据: 实际输出正确覆盖全部 11 个参考答案，但额外误纳 5 家不满足\&\#34;双榜共现\&\#34;条件的餐厅，导致集合不等价。错误根源在于模型对两年榜单交集的验证不严，将部分仅出现在单年榜单的餐厅错误归入答案。

- `DSQA\-0023` **\[部分通过/语义匹配错误\]**

    - 题目: Of the five countries with the highest per capita death toll from COVID\-19 \(cumulative as of 2023, according to Johns Hopkins\), which have a

    - 参考: Hungary: 2009, 2020, Bulgaria: 2009, 2020, Bosnia and Herzegovina: 2009, 2020, North Macedonia: 2020

    - 实答: Peru: 2020; Bulgaria: 2009, 2020

    - 判分依据: 答案集合错误：实际输出与标准答案的国家集合不等价。正确集合为 \{Hungary, Bulgaria, Bosnia and Herzegovina, North Macedonia\}，实际输出为 \{Peru, Bulgaria\}，两者交集仅 Bulgaria 一项。Peru 不属于合格国家，三个正确国家未被识别，属于事实/集合匹配错误。

- `DSQA\-0028` **\[部分通过/语义匹配错误\]**

    - 题目: Obama\&\#39;s White House reports that a man named Frank Cordie started a brick company in 2010, in hopes of revitalizing a city\&\#39;s brick industry\.

    - 参考: \(West\) Boulevard Street, \(West\) Curtis Street

    - 实答: West Boulevard, West Curtis Street, East Anderson Street

    - 判分依据: 模型正确找到 West Boulevard 与 West Curtis Street 两条核心街道，但额外输出了 East Anderson Street，该街道不属于参考答案所指定的符合条件的小学街道集合，造成答案集合与标准答案不等价。

- `DSQA\-0034` **\[部分通过/回答不完整\]**

    - 题目: Refer to macrotrends\.net for NVIDIA’s historical annual stock price data and to worldometers\.info for United States GDP percentage change\. F

    - 参考: 2021, 2023

    - 实答: 2021

    - 判分依据: 实际答案集合 \{2021\} 是标准答案集合 \{2021, 2023\} 的真子集，缺失核心项 2023。模型对 2023 年两项指标（NVIDIA 股价涨幅 \&gt;125%、美国 GDP \&gt;2\.5%）的核查存在遗漏，未能正确判定其同时满足双重条件。

- `DSQA\-0036` **\[部分通过/语义匹配错误\]**

    - 题目: I\&\#39;m looking at the late sockeye run for the years 2018 to 2023, according to the the Alaska Dept\. of Fish and Game\&\#39;s Fish Count Data Search\.

    - 参考: 2019, 2021, 2023

    - 实答: 2019, 2020, 2021, 2023 Sources: \- \[Fish Count Data Search \- Alaska Department of Fish and Game \(Kenai River Late\-Run Sockeye\)\]\(https://www\.adfg\.alaska\.gov/sf/Fi

    - 判分依据: 实际答案包含 reference 中不存在的 2020 年。根据 reference（客观事实基准），2020 年累计量未超过 180 万，但模型将其纳入符合条件的年份集合，属于阈值比较/数值读取偏差导致的多出错误项。

- `DSQA\-0039` **\[部分通过/回答不完整\]**

    - 题目: As of 2023 data, which countries in Asia have a population of over 50 million while also having a 2022 GDP per capita of less than $10K in t

    - 参考: Philippines, Vietnam, India, Pakistan, Bangladesh, Myanmar

    - 实答: Bangladesh, India, Myanmar, Pakistan, Philippines Sources: \- \[Maddison Project Database 2023 – University of Groningen\]\(https://www\.rug\.nl/ggdc/historicaldevelo

    - 判分依据: 实际答案与标准答案集合不一致：漏报 Vietnam，该国满足题目全部四个约束条件。

- `DSQA\-0038` **\[部分通过/语义匹配错误\]**

    - 题目: I’m going to school for my MSW, and I’m not sure which school to attend\. I’d like to stay in what the Bureau of Labor Statistics calls the “

    - 参考: Fort Hays State University, Washburn University, University of Wyoming

    - 实答: University of Wyoming, Fort Hays State University, University of North Dakota, University of South Dakota, and University of Montana\. Sources: \- \[BLS Mountain\-P

    - 判分依据: 实际答案与标准答案集合不等价：缺少核心项 Washburn University，且含 3 所错误院校（North Dakota、South Dakota、Montana 州大学），超出集合相等容差范围，违反集合完全相同才算通过的规则。

- `DSQA\-0043` **\[部分通过/语义匹配错误\]**

    - 题目: According to the 2023 estimates from the CIA World Fact Book, of the countries in the Middle East that produce oil in the millions of barrel

    - 参考: United Arab Emirates \(Nuclear, Solar\), Iran \(Nuclear, Solar, Wind, Hydroelectric\), Oman \(Solar, Wind\)

    - 实答: 1\. **Iran** — hydroelectric, nuclear, solar 2\. **United Arab Emirates** — solar, nuclear 3\. **Iraq** — hydroelectric Sources: \- \[Iran \- The World Factbook\]\(http

    - 判分依据: 实际答案与标准答案存在两处差异：①第三名国家答为 Iraq，但正确答案是 Oman（集合不等价，属张冠李戴）；②Iran 的非化石能源类型漏报 Wind（4 项中命中 3 项）。核心失误在于对中东主要产油国非化石能源占比的排序判断有误，导致 Oman 被 Iraq 替代。

- `DSQA\-0046` **\[部分通过/语义匹配错误\]**

    - 题目: List all of the nucleoside reverse transcriptase inhibitors that have kept their FDA approval rating since the 1900s and contain a carbonyl

    - 参考: Lamivudine, zidovudine

    - 实答: Zidovudine, didanosine, stavudine, lamivudine Sources: \- \[Discovery and development of nucleoside and nucleotide reverse\-transcriptase inhibitors \- Wikipedia\]\(h

    - 判分依据: 实际答案是标准答案的超集：核心项全部命中，但额外包含了 didanosine（2004 年撤市）和 stavudine（因毒性退出主流，不符合\&\#34;kept approval\&\#34;要求），导致集合不等价，属于过滤条件理解/执行偏差。

- `DSQA\-0052` **\[部分通过/回答不完整\]**

    - 题目: Using Statistics Canada, list all names for boys that stayed within the top 5 baby names for boys between the years 2019 and 2022\.

    - 参考: Liam, Noah, William

    - 实答: Noah, Liam

    - 判分依据: 实际答案漏掉核心项 William，与标准答案集合不等价（缺 1/3 核心项）。Noah 和 Liam 均正确，但题目明确要求列出\&\#34;所有\&\#34;符合条件的名字。

- `DSQA\-0057` **\[部分通过/语义匹配错误\]**

    - 题目: Of the school districts in Maricopa County that had a 4\-day a week schedule for the 2023\-2024 school year \(according to the Maricopa County

    - 参考: Wickenburg Unified District

    - 实答: Cartwright Elementary District and Wickenburg Unified District\. Sources: \- \[This West Valley district has a 4\-day school week to help keep teachers \- Copper Cou

    - 判分依据: 模型在筛选 Cartwright Elementary District 时未能准确核验其 Title I 学校的\&\#34;无经验核心教师/校长/领导层比例 ≤25%\&\#34;或\&\#34;紧急资质教师比例 ≤5%\&\#34;等约束条件，错误地将其判定为达标，使最终答案集合包含了一个不应入选的学区。

- `DSQA\-0062` **\[部分通过/回答不完整\]**

    - 题目: Which universities in the top 20 of the QS World University Rankings for 2021 were also in the top 10 US University Rankings and the top 10

    - 参考: Columbia University, Harvard University, Princeton University, Stanford University, Yale University

    - 实答: Columbia University, Harvard University, Stanford University, Yale University Sources: \- \[QS World University Rankings 2021\]\(https://www\.prnewswire\.com/news\-rel

    - 判分依据: 实际答案与标准答案的差异明确：实际输出集合 \{Columbia, Harvard, Stanford, Yale\} 是标准答案集合 \{Columbia, Harvard, Princeton, Stanford, Yale\} 的真子集，缺少核心项 Princeton University。模型在三榜交叉检索时漏掉了 Princeton，属于检索/推导不完整。

- `DSQA\-0069` **\[部分通过/语义匹配错误\]**

    - 题目: I am doing a study on the performance of rail operators in the UK\. Identify the rail operators that had between 5 and 10 million passenger j

    - 参考: East Midlands Railway, TransPennine Express

    - 实答: East Midlands Railway, TfW Rail, TransPennine Express\. Sources: \- \[Table 1223: Passenger journeys by operator \(ORR\)\]\(https://dataportal\.orr\.gov\.uk/media/1476/ta

    - 判分依据: 实际输出多含一个错误运营商 TfW Rail。根本差异在于第三轮延误赔偿数据的筛选逻辑出现偏差——TfW Rail 未同时满足批准率和索赔量两项阈值，但模型仍将其保留在结果集中，导致答案集合与标准答案不等价。

- `DSQA\-0076` **\[部分通过/回答不完整\]**

    - 题目: Which US states \(do not include Washington DC\) had fewer than 100 total fatal car crashes in any year between 2016 and 2019, using NHTSA dat

    - 参考: Alaska, Hawaii, New Hampshire, North Dakota, Rhode Island, South Dakota, and Vermont

    - 实答: Alaska, Vermont, Rhode Island Sources: \- [2016 State Traffic Data \(DOT HS 812 581\)](https://crashstats.nhtsa.dot.gov/Api/Public/ViewPublication/812581) \- \[2017

    - 判分依据: 实际答案与标准答案集合不等价：仅命中 7 项中的 3 项，缺失 Hawaii、New Hampshire、North Dakota、South Dakota。根本原因为检索覆盖不全，未系统扫描全部 50 州各年份数据，仅提取了部分低值州。

- `DSQA\-0093` **\[部分通过/回答不完整\]**

    - 题目: For each mental health committee annual report up to and including 2023 on nysenate\.gov, of which senator Samra G\. Brouk was the chairperson

    - 参考: Senator Samra G\. Brouk, Senator Gustavo Rivera, Senator Anthony H\. Palumbo

    - 实答: Senator Gustavo Rivera and Senator Anthony H\. Palumbo\. Sources: \- \[2021 Mental Health Committee Annual Report \(PDF\)\]\(https://www\.nysenate\.gov/sites/default/file

    - 判分依据: 实际答案遗漏了 Senator Samra G\. Brouk 本人。问题要求列举在全部相关报告中均出现的委员，Brouk 作为主席在每份报告中均有署名，属于答案集合中的必要项；模型将主席身份与\&\#34;委员出现\&\#34;混淆，产生解读偏差，致使集合缺失一个核心项。

- `DSQA\-0100` **\[部分通过/回答不完整\]**

    - 题目: Using only the stats for the year 2021, of the universities in the top 7 on the World University Rankings of both QS and the Times Higher Ed

    - 参考: Harvard University, Stanford University, University of Cambridge, and University of Oxford\.

    - 实答: Harvard University, University of Cambridge, University of Oxford

    - 判分依据: 实际答案与标准答案的差异：集合缺少核心项 Stanford University。模型对\&\#34;同时位列 QS History 前 7 AND THE Social Sciences 前 7\&\#34;这一交叉过滤条件的执行不完整，未能覆盖 Stanford 的专科排名数据。

## ❌ 未通过/答错 \(14 题, 含原因\)

- `DSQA\-0008` **\[未通过/语义匹配错误\]**

    - 题目: Which champion was picked most often by the losing team\&\#39;s top laner in the 2013 North American League Championship Series Summer Finals?

    - 参考: Karthus

    - 实答: Shen

    - 判分依据: 实际答案 Shen 与标准答案 Karthus 不等价，属于不同英雄实体，构成事实性张冠李戴错误。

- `DSQA\-0016` **\[未通过/语义匹配错误\]**

    - 题目: List all of the countries that meet all of the following conditions: Is an EU member state as of 2024; Doesn’t have a monarchy; Had over 100

    - 参考: France, Italy, Romania, Portugal

    - 实答: Bulgaria, Greece, Italy, Romania

    - 判分依据: 实际答案与标准答案集合不等价：正确命中率仅 50%（Italy、Romania），同时缺失两个核心正确项（France、Portugal），并错误添加了两个不满足条件的国家（Greece 投票年龄不达标，Bulgaria 移民量不达标）。属多条件交叉筛选中的事实推导错误。

- `DSQA\-0029` **\[未通过/计算逻辑错误\]**

    - 题目: During the 2014 Term Year for the United States Supreme Court, how many certiorari denials were on the Order List on December 15th?

    - 参考: 86

    - 实答: 73 Sources: \- [ORDER LIST 12/15/14 \(2014\) \| FindLaw](https://caselaw.findlaw.com/court/us-supreme-court/121514zor.html)

    - 判分依据: 模型虽找到正确文档来源，但对 Order List 中 certiorari denial 条目的计数不准确，实际答案 73 与标准答案 86 不等价（差 13 项，超出容差）。

- `DSQA\-0032` **\[未通过/语义匹配错误\]**

    - 题目: According to the Our World in Data migration chart and the IMF’s World Economic Outlook 2023 GDP per capita data, which countries had an abs

    - 参考: Romania, Egypt

    - 实答: Philippines

    - 判分依据: 实际答案（Philippines）与标准答案（Romania、Egypt）集合交集为空，属集合完全不匹配。模型对迁移数据或 GDP 数据的检索/筛选存在系统性偏差，错选了不符合条件的国家，同时漏掉了两个正确答案。

- `DSQA\-0035` **\[未通过/语义匹配错误\]**

    - 题目: By comparing the results from all the exam periods between March 2022 and March 2024, what exam period had the highest percentage of those r

    - 参考: March 2022

    - 实答: June 2023

    - 判分依据: 实际答案与标准答案不等价：实际输出 \&\#34;June 2023\&\#34; 与标准答案 \&\#34;March 2022\&\#34; 指向不同考试期，属于事实性错误，非格式或精度差异。

- `DSQA\-0040` **\[未通过/语义匹配错误\]**

    - 题目: According to fishbase\.org, name the species of fish that are both dangerous and introduced from the following states that have more than one

    - 参考: Lepomis gibbosus \(Pumpkinseed\), Micropterus salmoides \(Largemouth Black Bass\), Ctenopharyngodon Idella \(Grass carp\), Cyp

    - 实答: Northern pike \(*Esox lucius*\) Sources: \- [Northern pike \| Washington Department of Fish \&amp; Wildlife](https://wdfw.wa.gov/species-habitats/invasive/esox-lucius) \-

    - 判分依据: 实际输出与标准答案 8 个物种完全不重叠（0/8）。Northern pike \(Esox lucius\) 不在标准答案中，标准答案中所有 8 种均未被命中。核心原因是模型既未使用 fishbase\.org 作为权威来源，也未正确实现多州交集逻辑。

- `DSQA\-0054` **\[未通过/语义匹配错误\]**

    - 题目: According to the data provided by the NHTSA, which of the following states saw the greatest increase in traffic fatalities between the year

    - 参考: California

    - 实答: Florida

    - 判分依据: 实际答案 Florida 与标准答案 California 不等价。模型在三州（CA/FL/TX）增幅比较中得出了错误结论，可能源于对 NHTSA 数据的错误回忆或检索结果偏差。

- `DSQA\-0053` **\[未通过/语义匹配错误\]**

    - 题目: Of the BRICS countries as of JAN 2024 \(not including Saudi Arabia\) that had a GDP per capita above $4000 in 2023 \(World Bank, Constant 2015

    - 参考: Egypt

    - 实答: Brazil

    - 判分依据: 实际答案 Brazil 与标准答案 Egypt 不等价（不同国家实体）。根本原因是模型在筛选满足两项约束条件的 BRICS 国家时出现解读或数据比对错误——Brazil 的城市贫民窟比例极可能超过 20% 而被排除在候选池之外，真正同时满足 GDP 门槛且贫民窟比例低于 20% 并具有最高 NEET 比例的国家是 Egypt。

- `DSQA\-0056` **\[未通过/语义匹配错误\]**

    - 题目: Among Saia, Inc\., Matson, Inc\., and ArcBest Corporation, which company had the greatest reduction in operating expenses for the fiscal year

    - 参考: ArcBest Corporation

    - 实答: Matson, Inc\.

    - 判分依据: 实际答案与标准答案指向不同公司：模型可能在检索或计算 2023 财年各公司经营费用变动时，错误地将 Matson 的数据排在首位，而未能正确识别 ArcBest Corporation 的降幅更大。

- `DSQA\-0061` **\[未通过/语义匹配错误\]**

    - 题目: According to the National Park Service, using their NPSpecies data, compare the number of Non\-native birds at Zion National Park, Canyonland

    - 参考: Chukar, Eurasian Collared\-Dove, European Starling, House Sparrow, Rock Pigeon

    - 实答: Arches National Park \(4 non\-native bird species, vs\. 3 at Zion and 2 at Canyonlands\): \- Eurasian Collared\-Dove \- European Starling \- House Sparrow \- Rock Pigeon

    - 判分依据: 实际输出在数据检索阶段获得了与标准答案不符的 NPSpecies 数据：Arches 被计为 4 种（缺 Chukar），Zion 被计为 3 种，Canyonlands 为 2 种；而标准答案对应的最多公园有 5 种（含 Chukar）。核心缺项导致公园识别错误和物种列表不完整。

- `DSQA\-0075` **\[未通过/语义匹配错误\]**

    - 题目: Out of all the GeForce GPUs released before 2020 that have over 1 GB base memory, what is the BUS width of the card that was known for black

    - 参考: 352 bit

    - 实答: 256\-bit Sources: \- [GeForce GTX 970 specifications \- NVIDIA](https://www.nvidia.com/en-us/geforce/graphics-cards/geforce-gtx-970/specifications/) \- \[GTX 970 Bla

    - 判分依据: 实际答案 256\-bit 与标准答案 352 bit 不等价。模型错误识别了\&\#34;以黑屏/BSoD崩溃著称\&\#34;的 GPU，将其定位为 GTX 970（内存分区争议卡），而非总线宽度 352\-bit 的目标卡，导致核心数值答错。

- `DSQA\-0084` **\[未通过/语义匹配错误\]**

    - 题目: According to JDPower, which of these companies released the most SUV models in 2014? Ford, GMC, Jeep, Dodge, Chevrolet, Cadillac, Nissan, Li

    - 参考: Toyota

    - 实答: Nissan Sources: \- [Explore 2014 Nissan SUV Models \| 2014 Nissan SUV Lineup](https://www.jdpower.com/cars/2014/nissan/suv) \- \[Explore 2014 Ford SUV Models \| 2014

    - 判分依据: 实际答案与标准答案不等价：Nissan ≠ Toyota。模型在汇总 JDPower 各品牌 2014 年 SUV 车型数时推导有误，最终选错了排名第一的品牌。

- `DSQA\-0091` **\[未通过/语义匹配错误\]**

    - 题目: Based on data from United Nations Population Division, among Italy, France, Germany and the United Kingdom, which country had the greatest d

    - 参考: United Kingdom

    - 实答: Italy

    - 判分依据: 实际答案与标准答案指向不同国家（Italy vs United Kingdom），在 1969 年五岁以下儿童死亡率与欧洲均值差距最大这一客观事实上，模型给出了错误的国家。

- `DSQA\-0095` **\[未通过/语义匹配错误\]**

    - 题目: Of the OECD countries that rank in the top 10 for Mammography machines per 1,000,000 in 2023, which is classed as most equal in the 2023 Gen

    - 参考: Finland

    - 实答: Belgium Sources: \- [Mammography machines \| OECD](https://www.oecd.org/en/data/indicators/mammography-machines.html) \- \[Healthcare resource statistics — Eurostat

    - 判分依据: 实际答案 Belgium 与标准答案 Finland 是不同实体，不满足语义等价规则。根本原因在于模型在\&\#34;OECD 乳腺X光机 top 10 与 EIGE 最高分\&\#34;两个条件的交集判断上出错，选了 EIGE 得分更低的 Belgium 而非得分更高的 Finland。

## ❌ 执行失败/拒答 \(5 题, 含原因\)

- `DSQA\-0007` **\[执行失败/执行失败\]**

    - 题目: List all the years that passed between the completion of the MLK Park Neighborhood selection of IVNA for Feasibility Study and the Fred Bunn

    - 参考: 2019, 2022, 2023, 2024

    - 实答: I can\&\#39;t verify these specific dates from authoritative sources\.

    - 判分依据: 模型选择拒答而非作答，未输出任何年份信息，与标准答案完全不等价。

- `DSQA\-0044` **\[执行失败/执行失败\]**

    - 题目: Of the countries that the WHO listed in 2017 as having 100% of their hospitals following national dementia standards, which country has had

    - 参考: Italy

    - 实答: I don\&\#39;t have a verified answer to this question\.

    - 判分依据: 实际输出为拒答，未提供任何事实性答案，与标准答案 Italy 无法比对，判为执行失败。

- `DSQA\-0047` **\[执行失败/执行失败\]**

    - 题目: Which municipalities in the Vancouver Lower Mainland saw an increase specifically in passenger vehicle population by 10,000 vehicles or more

    - 参考: Surrey, Burnaby, Richmond, Langley

    - 实答: Unable to retrieve from authoritative sources — the per\-municipality passenger\-vehicle counts for 2020 and 2023 live only inside ICBC\&\#39;s interactive Tableau dashboard, which doesn\&\#39;t expose the underlyi

    - 判分依据: 模型判断 ICBC 数据仅存于 Tableau 交互式仪表板且无法抓取，遂选择放弃作答而非尝试替代检索路径（如 ICBC 年报 PDF、BC Data Catalogue 历史数据集等），导致最终答案为空，与标准答案 \{Surrey, Burnaby, Richmond, Langley\} 完全不符。

- `DSQA\-0071` **\[执行失败/执行失败\]**

    - 题目: Please provide me with a list of fires from the San Francisco database of fires up to May 2024 that involved more than 1000 suppression unit

    - 参考: 11120831, 14018336

    - 实答: I cannot answer this from my own knowledge, and I don\&\#39;t have web search available in this environment\.

    - 判分依据: 模型未尝试作答，输出属于\&\#34;拒答\&\#34;，与标准答案（11120831, 14018336）完全不等价。根因为 skip\_tool：应调用 web\_search 或数据库查询工具获取旧金山火灾数据库记录，但模型声称环境内无 web search 可用并就此停止，未做任何尝试。

- `DSQA\-0066` **\[执行失败/执行失败\]**

    - 题目: List the Klein ISD high schools in Texas from highest to lowest attendance rate for the 2017\-2018 academic year, based on tea\.texas\.gov data

    - 参考: Klein Cain High School, Klein Oak High School, Klein Collins High School, Klein High School, Klein Forest High School

    - 实答: I was unable to retrieve verified per\-campus 2017\-2018 attendance rates for the five Klein ISD high schools \(Klein, Klein Collins, Klein Forest, Klein Oak, Klein Cain\) — the TEA TAPR report server \(rp

    - 判分依据: 实际答案为空/拒答：模型以无法访问 TEA 服务器为由，未输出任何排名结果，与标准答案要求的完整五校降序排列完全不等价。

## ⚠️ 脚本异常 \(5 题, 非 claude 答题质量问题\)

- `DSQA\-0009` \[ERROR\] claude timeout 480s

- `DSQA\-0010` \[ERROR\] claude timeout 480s

- `DSQA\-0085` \[ERROR\] claude timeout 480s

- `DSQA\-0083` \[ERROR\] claude timeout 480s

- `DSQA\-0096` \[ERROR\] claude timeout 480s

