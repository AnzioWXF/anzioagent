// DSH IDE — Client bundle（应用本体）
//
// 浏览器端正式插件：注册 root 槽替换默认布局 → 打开页面直接就是
// 三栏 IDE（左：文件资源管理器 / 中：文件详情页 / 右：Agent 助手 + 插件面板）。
// 数据全部经 fetch 调 Host 半的 /dsh-ide/* JSON API（lib/index.js）。
//
// Bundle 格式：window.__ModuleLoader__.load({ id, factory(require) })，
// 依赖经注入的 require 从模块表解析（react、@deepseek-ai/dsh-client-ui-slots 等）。

window.__ModuleLoader__.load({
  id: 'dsh-ide',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var h = React.createElement;

    // ── AI 回复的 Markdown 渲染（2026-09-17 用户实测：以前全是纯文本）──────────
    // 复用平台组件（§7「能买现成的就买」，ui-primitives 在 bundle 白名单里），
    // 标题/列表/表格/代码块/公式/脚注一次到位，不自己写解析器。
    // ⚠ labels 必须**引用稳定**（§6 25）：每次新建身份会丢掉流式渲染缓存，
    //   缺了它在第一个代码围栏处就抛错。所以做成模块级常量，只建一次。
    var uiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives');
    var MarkdownText = uiPrimitives && uiPrimitives.MarkdownText;
    var MARKDOWN_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

    // ── 品牌（2026-09-17 改名"天工"）──────────────────────────────
    // logo 以 data URI 内嵌：只有 16~18px 一处用途，不值得为它加一条静态路由
    // （源图 D:\logoV2p.png → tools/make-logo.ps1 生成 64px 圆角瓷片）。
    var LOGO_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAABUhSURBVHhe7ZkJVFPX1sf7Xs1ASAhJCAgoKqIiqExRQKBghSKDiAODCsrg2KpUxTqL81C1ra11HhAQBAVRFEHmUYYAgZAEAggIQQEBURTH/t9KaN+y92sf2tb36rf8rXXWveuePayzz97nnnvuRx994AMf+MAH3j1iLS1OOUPdgs/g+hWqqG0qpnMOFSmzTpUxOLsFTLVAkcZwQ6LOe4943Lgx4uEj1ldq6WSUcQZ2iphc1DHUUMvgoJbORq0yC3XyRmdDQGf/VMlUS8oZOsKIaOe94vhHZiTpp9Y+NVYTsqpMjX66a2iAhiFDIdLQQjmTizI6GyV0NorprH83fl8AcJumChGD/bhw9NjJRLvvBQ1zpvnenuEsanP7DDIHG1Sbm0JkoA+hzhAI1DVRxlRDqSIA8kGzwFdWBZ+uqghCKYOj6JPSVCFQ1+6o8A7UINr/2yJZ5MtrWjgnu3PhHMh8ZqDazQESexuILHmoHGuAiqFDIdDQQhmLizIVdl8QlFkooTFRKr/S+56VMzgoo3PQrMqF0GT8JqKfvyX1q5eslgUvedaxajFuB8yG1GcGqmY4QeJoB6GtBYRmRhCOHAnBYB2UqQ2EQFUNAoZ8wCwI5E2ZpSiLcjoHAhUOBEw11DM5qDQYe5Po629FjMdHH9/ZFBT2eNd6NK9fgdqghahZ5APpfE9IPKdCMtUBIntrCCfyIDQeC+GoUSgfpINytYEoZ3FRzpAPmo1yZXkg2KhgcBQZIO9rYKmheuzYTKLPvw35K2cpNe1al/Tk2+1oDAlG3boVqF29FNJlAZAumItqn5kQz3KG2GkSRJOsFKUgMjZCpf4oCHWGokJDG0KWBipVuBCqqPU1VS4q2Oqo4GqiXUML9bZ2x4l+f0HcXMiRNpUPIj7/r4CQkH82fb0l6emxA2jYuxm3d6xD3eZVqP1qGWpWLkb1536oDvBG1Vx3SGY6o8p5smI9EFubQ2RmDJGhIUTD9SDS1oFIQxtirqaiidS1IFTXRJWGJu6NHIXmjRsnEn3/Qp2sUkfUVJ5T3yk9liXMGkzsf6c0frvj5POzP6Dpu91oOLANt+VB2Lm+Lwhrl6F+1WI0L/NH6+K5aPP3xL3Z7mh2d8TtKZNQNckKVZY8SEzGQWygD/Hw4ZDoDodkqC4kQ4eherAOevT0UDd16gmiXyKChoJhVa3CB7Vd1T2l9cWrif3vhLof9ix4GnEMsmMHcefw12j4bjfqD2xHw74taN23Gd1fb0Hj5lUvmrYEixvXrrjcELTwTP3nfgmN8zxFDTOdX3TPmIJWp0mos7WA1MIMUtNxkBqNwe1xY9BuqI9HxkaQubqeA/Ax0fdvUSjOHlnRUvaw5VUzihoKL+dU5LCIMn8Zd89+O7Qt9Mee++HH0HTqezSe+BYNR/aj9egBPD75He7+uL+649QPwW3X40YSdeW07ds0omXhnOCWOe4FLe6Oz7tcPkWPox0eTbZBi5017rtMKW5fscKHqNcfRdJ82zIZ/5W0R4L8O3niFHH2b/r/0zSFHrnx9EoUmsKOozn8OJpCj6An6hTazx1t77wcufynn36iEHV+jwe7Q/Taly+Y1rVsceDD1ctnPfpm75/6Dsirztok6ioHv60IGfUZzRk1GXpEmT/F3ajTrr3XLuJuTBhk0aG4F3MOz67F4H5cZJIsJ0eHKP/fJiYm5uOs2nRRfksu8lpzcKPmhiSjMoNOlPvDtFwMK3mcHA9ZXCRa46PwPPUqOlMTDhLl/pdk1qY63WrNww1pIrLaMxEnir9ElPlDyC6H2/SkJODe9Tjcux6Ll3mp6MhK3kWUe0voJBLJhEwju5CVyG4DBgwYr6ys/Kf3/olV10rSW9JwueoykttTEV0Z+wVR5q1pvX4p/OWtDLTeTMBP/Fy05aQdJcq8KRTKx/ZkCvk8VZkiU2Yog65CVzT5vRKN2k0ik5IYDGWfkJCQfxJ134QESUJAels6YiQXEV17CRGSC90J1QnaRLk35m5ymHJrytW2h3npeFWaj85bGWlEmTeBQqHoUmmUKzQGDWwuB1qDtaGrNxx6o0ZghP4oDB+hB61B2lDjqoHBZIBKo/BZLJYV0U5/xApi1S9VXeqJrrmIs8JwXJDF4kxF+Dmi3BtzNyPBrrc4B09K8vCIn9vZ0yDWJMr0B4VCsVNSVrrP5LAwaKgOxhiNg6W1FSY72GOKk5Oi2Ts44BNbWxibmUJn6FCw1TjyrHjB4XCWEO31R6T4QsalO5dxsiIUxyrP4Lg49FWUMG40Ue6NuJ+Tsh5VAqC2Eg8qSxYR+/tDSWkAT0mZ+kQ+6/KZtrKxwbTp0+EfEIBly5cjODgYa9YEIyhoBRYuWoRZHh6wnTQJow0NoKbBBV1FGZqa6guJdv8T50Thu6NlsThSfgrflR3DyTvhOFJ++o+VbWdhZhRa6tBdUVwB4G3rkqFEo9ax1NgYOVof9g72mDd/PtauXYOD+/fh+LGjOHvmNELPnsGJ48fw7TcHsXnTRgQGBsLB0REGYwzB4XKgTFd6oa+vb0Y0/nv8KDjmdao+DN8IfsT+0h9wsPJHfF16uOta4x/YJXaV5t9CpwyPbld5Efv6g0wlfa/CYkJ3hB4+sbODv78/dmzfhrOnTyEh/jIy0lKRm5ONvNwcZKSnIeFqPMJCz2LPrp1YuHAhJts7QG/USNCZdKipsYoA/IPo47fYU7zf7oD4R+wu+QY7+Aews+QgDtQdxXelJ+cQZfulu6K4sadK2AaATOz7T1CpVB0qjfpMQ0sTEyzM4e09WzG74aFnFQMvF5SiRlqNhoZ6NDbUo6amGgJBqaIvKiIC27duhY+PD8wtLaGhOVCeBTA1NXIh+vktQkr2fLKz8iA2Fe/G+sKdWF+8G9tqvsM2/jfhRNl+6RaXdj66LTlFfN4fVCp5LYOpgmF6w/GZoyOCgoJw/OgRpCYnQVRZgRZZEzo62tHd/QAPH3ajo/M+ZLI7qBQKkJaSjFMnjmPll1/CcYoTRowaBRqdhkGDtN5oY/NVwTaXTZV7sbpwC768tRkrb23BV+W7sLZgV9Vbl/EjaWX946baGcTn/UGmktNZahwYjBmDGdNnYOuWLYiNiUZFWSnuyprx8OED9PY+xrNnT/H8xXM8fdareNbc1AB+UQFiL8Zg147t8PDwwBgjI8hLicNlt+Tn5ysRfRH5IvurVatE27E0bx0W536FxXlr8UXhJqzI3/osquby250d9DTWHXook+kTn/cDlUwhNXO4XJjyeJg3bz6+PXgAKTcSUSutQldXJ54+7cXz58/x4sULvHjZ13p7n6DjfhuqxEIkXU/Ad98chL+/H3jm5mCry/cH9J98vbz6/dLzz1gRu6hsHeZnfYl5WUGYl70SgXnrsJQfgr2lh373kOU3qa+vp7512nz0EYdMIXVxNTQw3twcAQGBOHr4MHKzM3GnsV6R8s+eP/v34F/+HAB5UB50deB2rRTpqTdx+IfvFYuhhZUVuJoDoaLKgKurqzXR2esE5AYwPNMWdXrnfA7P9CXwSF+C2RnLMC9nNRaUbsTaoj1TiTrvAjaZQu5S01CHGW88/P0DcPjQIWRnpKGpsR49jx72zf7Pg3/58iVevHypKIeurg7U1lQrAvDDoUOKV6L5xImKADBZDLi7u9oSnb3O1ESfwJmFi+GcPB/ON/3gkhIA97TF8MhcDv/ydVhXstefqPMuIJNIHzeyOGwYGRtjzpy52L9vH5ITr6GmWoIHnR149qz336nfF4AXePLkMdrbWyERC5F4LQFf79uHub6+MObxwOaqKTIgYO7cUURnv+AR40GfnOjV6JDuA9vr3rBLnA37JF843vSHa/oSeJeuxuqi3b5EvXcCiTQgjaHCUKzgrq5TsXH9BsRERaKMX4yW5iY8UiyCT/D8+TPFIii/7+7uUpRIQX4uIiPCsXHDBrhNc8coQwMoq9ChPlCtVSBIVib6+gWLeLdL1hleGB8/Hbyr0zEhYSYsr3nCOnEOJt/0g1v+UnyRt8GRqPdWMCbHcZTc06dRZmUtoHpkemp6pPzmYQiNSt1AVaIqPnAmWlkhMCBQsRDKFzdRRTlkzXf6XoMPutD98AE67rejsbEeJfwiXI2Pw8EDBxT1b/XJJ9AeogOyEhkjR+peIfqRY3bcjGR4yT7UJMUNhnFOMIibAoM4Z4yJnwrjq+7gXfPAxKQ5+CzVH5uKDpgQ9d8Yssv1DWS39DbKrCKQvUtBnlMKJe/8Hubs7MMT5oarvC7LZDJ1yWTSS1WWKkaNHg1nZxesWvkljh7+HtevxKO48BaqJCLU1khRV1MNsUiIW/l5uHI5Dj98fwhBK4Lg4uoKfUNDqLBVocygwdXVaebrPuTonrIcM/yS3a0RSQ4YFm2HIdF20Imxw5BL9tCLc4RBvAuM5EFI8sDkG76PrlZlqBFtvBHkKfHHyLNKQZqWDZJbGkjT0kGangmyZx6U/CrB9M0T2SxLHva6jrIS9TRViQL1gRowNjHBtGnTsDIoCAf3f43wc6G4eiUeyUmJiqyQDzz0zBns27sXK5avUMgam5pCvpP8mPwxdIcPlQAgvW5f/7S1re4lm+4hCXbQjLSCxvmJ4EZaQiNqIjSjbTD44iToxjrA4LIrjG9Oh0Oir+B1/TdGySF+FsktHwNcUjHANQUDXOXXVAxwkwchA5SZWaD6icCdly0MCcmg/qJnrKfHpVDJrVQaFQO1NDHOyAhOTk7w9/PDmuBgbN+2TbE47t29B9u2bsWqVaswf/58ODo6YpyJCTQHDQKFRgWLowp/f99frf7aJyYMGhxp2aV92RrqEebgRphD7bw5OOcnKBo30gIaUdbQjrbDiFhHjEtzh3vSgpOv23hT/kH9LKGY7JIH0pSbIDmn9gVC3qamgTwtHZQZmaB45YC2oBqjF2X96o+utobGJKoS+ZUSjarIhJGjRsLC0kIxSHd3d3h5ecPT0wvTp8/AZ45TMMHCEiP09aGhpQUylQwVJgMuTk7rX7cpZ1CY5QXNBBtwwiaAEzFe0djhPKiGmYEVLr8fD3aEOdSjrDEkZhKMbrphVc42D6KdfqHZhGuS7RN6yU7poDjeBGVKKsjOKSA5p/wcgAyQZ2SB4pULil8ZNBbckkVH/3q7qqs7ZAaNRnlMoZKgymJioLYmhusNx2iD0RhrZISxxkaKT1/5V+NAbW2osFQVaS+XdXCYvPl1W3IGh04crhlp+YobbQF2BA+scDMww+TNFCrya7gZVMN54ERMADdqIgbGWsP0kmsnv47PJNrqF7LteX2S/TWQp6SAMkUegL6rIgC/lIBHNqizc6E0vxCcpeVw2yYwJ9oxGDHCmMmkF1OVyCBTBijOAFU5LMXxmLzJ7+WvugEUEuTrhs6QwTVz53q7Ee3IGXja3Efjio0i1eUzzjxnCpVzJlAJMwH95yDIAyDPCO55Cwy6bgvXhHm/+6P1P6I1+RyHbH+9m+SYBvJnyaA49jV5FgxQzH4mKJ7ZUJqbB5p/IdjLq/FpSNFv/t0BMEBPb1igGodVqKJCB02ZCiqNLD//gzKdBjZbFcOGDRHa2X2yGsDvnulrhlqu5coDEN4XAJVQE0UAGIpmCoY8AyJMFZnBjjTDmDiHlycEJ/r9hvhdaPbXC8lOuSB/ltQXhCk3QXZNBWl6OigeWaAoZr8A9AXF4HwphX1Icb/neN4zZxryeDwvE5NxqywmTPhq8qRJc1YuW2b0Joce2qETFnPjrRQpLq93ZhgPDHkgFGVgBtXzPDAjzMCK4EHjqgXc4n2PEG28FSqTryylOBf0zfyUZJCcbypeheSZmaDMzgHVNx9KAQWgL+FDLbgOtltL/0/d/pUYnrYy0rhgAc4FS8VCpxo+HvQI+aDl68F4sCMngCUvjzgeeLEu9VKp9Fd7lLdmols8g+aQ2E52zgbZ6SZIrmkgz8gAxTMLlLm5oPrlQ3lhIZhf8KG+tgYmG0vOE2381eiGW91Qv2YNznkLqEaagxHJA/M8DyrhPMXMM2N50I+b/Dgka6cpUfcPoTU1YSnFrUiR+uTpGSB7ZIPinQ2Kbx6UFhZAZWkRuEHF0FknxLhNgrawZMHv7tn/CjxifHV0L9jI1K9bgx1jDuaF8VC5wAM9ygTMqzyMiXfoWJO6fhJR7w8jr03WtORi0iy+ou6p3jmg+uSCGihP/WKoLS/CoOASjNxQBtM9jXDZW7aMaOOvxuvy/KGGsQ7xgy9avdBOtIHWdWsMibN9bpMwK/Zo5pkRRPk/jbF/qoHyrLxe8pxCxeCV/POhvLgY7OV8DFzJh+7aEozbXIaJu6vgsE/cHhImUCfaeBcsSQsa5ZG52NM3K8jrZGXYX/tbnIje3GQf2nwBKH6FUF5YAOYXxdD4shhD1pTAcGMZJmwTwG53Oab+2Iy5hyUpRP3/F+guyNik8rkEKkv54K4oxuDVfOivLYHJFgE+2VUBx68r4f6tCIHnWrH0VNU7XxD/J4xenrtHPbgamqsF0PuqBEabyjBxewXs9wox9RsRZh8WY8EJCdZcasPayLrEkLOFA4k23ntM1xUE622QwHCzBOZby/Dp7gq4HhTB43sx/I5J8PmZKqwKq8aOax3YGX+naf+V255EG+89DtsLZlnsqLpve7AZjvvFmHlIDN+jVVh0qhpB56RYF1WDkIs1OHDjLo5mduJoqizzTNZdrzDB3bd+TRZI7/+5Dc27Iuho2VCnA5LY6Uea4HNahsCT1VgWKsWa81JsuViLXZfrcPBaAw4nNSLsVhcu8B/ifN69O9EF985cKmjxjS26O+ZaRSPr9W3wVT6fliXsGJwqvudQdOdJSFHjg4yy+vvTf+35b8bC4xK3Bafq+Cui27Aurg0bL9ZjR9xtHLjWgO9vNOBYSiPOZDThfG4zYvkdSK7qRZr0Ka4L2pAouHc/ueJeVUplqzhN1CrOELXK8mofoKEXELY8bhE1d7wf5QN89I9NMfXeW+Ia03fG38HhrEc4nt2FExktOJslw/lcGaLzZYgtbMHVkntIFLTipqgD2TUPUdj0HBXtQO1jQNIJVDT3VNbcffQFwP/VUdh7Q2h207hjac2bz2S15ITltDy4WNyBG+JepNc+R079S9y68xLFLa9QcvcVipt6UVDb9aSksbuisqXnUH17rx3R3nuNtOUhN6Wiw/JGeatfmrB9a7qobXeOuHVncX3X1orGB4uETY8mNXc8ebsflx/4wAc+8IE/z78ANFC23VQcaXQAAAAASUVORK5CYII=';

    // ── 样式（官方主题 token 驱动，跟随 Web UI 设计语言）─────────
    var css = [
      // ⚠ z-index 必须待在"平台弹层之下"这一档（2026-09-22 用户报障"三个下拉都用不了"）：
      //   平台的菜单/模态/toast 全都 **portal 到 document.body**，层次是 菜单 100（原地）/
      //   1100（portal）、模态 1000、toast 1100（ui-primitives Menu/Modal/Toast.module.css）；
      //   我方以前写 2000，等于把整个 body 盖在自己底下 ⇒ 菜单**打开了却在根节点后面**，
      //   看得见点不着（工作区 / 创造模式 / 模型三个下拉同时中招，权限那个是原地渲染才没事）。
      //   天工自绘的浮层（.dside-overlay 4000 / .dside-menu 60 / .dside-sash 35）都在本节点的
      //   堆叠上下文里，与这里的数值无关 —— 改这里不会动它们。
      '.dside-root{position:fixed;inset:0;z-index:10;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.5 var(--dsw-font-family);}',
      '.dside-titlebar{height:44px;flex:none;display:flex;align-items:center;gap:10px;padding:0 14px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dside-titlebar-path{color:var(--dsw-alias-label-tertiary);font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      // 标题栏品牌标记（工作空间路径左边那一小块，2026-09-20 用户要求）
      '.dside-titlebar-logo{width:18px;height:18px;flex:none;border-radius:5px;display:block;user-select:none;-webkit-user-drag:none;}',
      // 版本徽标 / 更新入口（AnzioAgent 壳内可见）
      '.dside-upd{flex:none;border:1px solid transparent;background:none;border-radius:8px;padding:5px 9px;font:inherit;font-size:11px;color:var(--dsw-alias-label-tertiary);cursor:pointer;}',
      '.dside-upd:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dside-upd.has{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);font-weight:600;}',
      '.dside-btn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 12px;font:inherit;font-size:12px;cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out),border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-btn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3);}',
      // 白字写死，不吃 label-primary-foreground：那个 token 是"贴在反色块上的前景色"，
      // 深色主题下官方值近黑（见下面 token 块的说明）——跟着它会变成蓝底黑字。
      '.dside-btn.primary{background:var(--dsw-alias-button-info-fill);border-color:transparent;color:#FFFFFF;}',
      '.dside-btn.primary:hover{background:var(--dsw-alias-button-info-hover);}',
      '.dside-btn.danger{background:transparent;border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.dside-btn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger);}',
      '.dside-btn.small{padding:2px 10px;font-size:11px;border-radius:6px;}',
      '.dside-main{flex:1;display:flex;min-height:0;}',
      // ── 底部整行（2026-10-12「路二」第一步）：官方右栏（终端 / 预览 / 浏览器 / 改动审阅）摆这儿 ──
      // 高度先写死（验证阶段），几何/可拖拽等观感定了再按 layout 那套做。
      // 渲染平台内容时的兜底文案（SlotErrorBoundary 用）
      '.dside-slot-fallback{padding:12px 14px;color:var(--dsw-alias-label-tertiary);font-size:12px;}',
      // ⑰ 拖拽手柄（照 VSCode 的 sash 规格，2026-09-21）：
      //   · **不占布局空间**：VSCode 的 sash 是 position:absolute 叠在分界线上（左右各压 2px、z-index 35），
      //     两侧面板的尺寸里从来不含它；这里照做（放在面板内部，right:-2px / left:-2px / top:-2px）。
      //   · 平时完全透明；hover 延迟 300ms（workbench.sash.hoverDelay 默认 300）或拖拽中，
      //     在拖拽区里画一条**满宽**线（--vscode-sash-hover-size = clamp(size,1,8)，默认 4px，不是 1px 细线）。
      //   · 光标：竖向 `ew-resize`、横向 `ns-resize`（VSCode 在 Windows/Linux 就是这两个，mac 才是 col/row-resize）。
      '.dside-sash{position:absolute;z-index:35;background:transparent;touch-action:none;}',
      '.dside-sash.col{width:4px;cursor:ew-resize;}',
      '.dside-sash.row{height:4px;cursor:ns-resize;}',
      '.dside-sash.right{right:-2px;top:0;bottom:0;}',
      '.dside-sash.left{left:-2px;top:0;bottom:0;}',
      '.dside-sash.top{top:-2px;left:0;right:0;}',
      '.dside-sash::after{content:"";position:absolute;background:transparent;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-sash.col::after{left:0;top:0;bottom:0;width:4px;}',
      '.dside-sash.row::after{top:0;left:0;right:0;height:4px;}',
      '.dside-sash:hover::after,.dside-sash.active::after{background:var(--dsw-alias-state-business-primary);}',
      '.dside-sash:hover::after{transition-delay:300ms;}',
      // 拖拽中：全局禁选 + 光标统一（VSCode 是给 document 注入 * { cursor: … !important }）
      'body.dside-resizing-col{cursor:ew-resize;user-select:none;}',
      'body.dside-resizing-col *{cursor:ew-resize !important;}',
      'body.dside-resizing-row{cursor:ns-resize;user-select:none;}',
      'body.dside-resizing-row *{cursor:ns-resize !important;}',
      // ⑰ 左侧面板外层（宽度由拖拽状态给，内层三种面板都撑满它）+ 右侧面板与终端都要当手柄的定位父级
      '.dside-leftpanel{flex:none;position:relative;display:flex;flex-direction:column;min-height:0;}',
      '.dside-explorer{width:100%;flex:1;min-width:0;background:var(--dsw-alias-bg-layer-1);border-right:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0;}',
      // ── 左侧活动栏（VSCode activity bar）+ 「操作 / 设置」面板的区块（2026-09-20 用户要求）──
      '.dside-activitybar{width:48px;flex:none;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;background:var(--dsw-alias-bg-layer-1);border-right:1px solid var(--dsw-alias-border-l1);}',
      '.dside-actbtn{position:relative;width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:none;border:none;border-radius:8px;cursor:pointer;font-size:18px;line-height:1;color:var(--dsw-alias-label-secondary);transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-actbtn:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dside-actbtn.on{color:var(--dsw-alias-label-primary);}',
      '.dside-actbtn.on::before{content:"";position:absolute;left:-8px;top:9px;bottom:9px;width:2px;border-radius:1px;background:var(--dsw-alias-state-business-primary);}',
      '.dside-activitybar .sp{flex:1;}',
      '.dside-block{padding:2px 10px 10px;}',
      '.dside-block-title{padding:8px 4px 4px;font-size:10px;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary);user-select:none;}',
      '.dside-block-row{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-block-row:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dside-block-row.off{opacity:.45;cursor:default;}',
      '.dside-block-row.off:hover{background:none;color:var(--dsw-alias-label-secondary);}',
      '.dside-block-icon{flex:none;width:16px;text-align:center;font-size:13px;}',
      '.dside-block-label{flex:1;overflow:hidden;text-overflow:ellipsis;}',
      '.dside-block-keys{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);}',
      '.dside-fontbtn{flex:none;width:20px;height:20px;padding:0;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1;}',
      '.dside-toggle{flex:none;margin-left:auto;min-width:34px;height:20px;padding:0 6px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:11px;line-height:1;}',
      '.dside-toggle.on{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:#fff;}',
      '.dside-fontbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dside-pane-title{flex:none;padding:10px 14px 6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);}',
    // 资源管理器标题栏 + 右侧动作按钮（VSCode 的 ViewTitle actions：新建文件 / 新建文件夹 / 折叠 / 刷新）
    // 可见性照 VSCode 的 workbench.view.alwaysShowHeaderActions 默认值 false：**悬停到该视图或它的标题栏、
    // 或视图里有焦点时**才显示（用户原话："我鼠标聚焦到标题栏后，这右侧这里应该有几个按钮"）。
    '.dside-explorer-title{display:flex;align-items:center;gap:6px;padding-right:6px;}',
    '.dside-explorer-title .ttl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dside-pane-actions{flex:none;display:flex;align-items:center;gap:1px;opacity:0;transition:opacity .12s ease;}',
    '.dside-explorer:hover .dside-pane-actions,.dside-explorer-title:hover .dside-pane-actions,.dside-leftpanel:focus-within .dside-pane-actions{opacity:1;}',
    '.dside-pane-act{width:22px;height:22px;padding:0;display:flex;align-items:center;justify-content:center;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;}',
    '.dside-pane-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
    '.dside-pane-act:disabled{opacity:.35;cursor:default;}',
    // 内联新建行（VSCode 在树里就地出输入框，光标直接落在名字上）
    '.dside-node-new{cursor:default;}',
    '.dside-node-new .dside-inline-input{flex:1;min-width:0;height:20px;padding:0 5px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:3px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;outline:none;}',
    '.dside-node-new .dside-inline-hint{margin-left:8px;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.dside-explorer-body{flex:1;overflow:auto;padding:2px 6px 12px;}',
      '.dside-node{display:flex;align-items:center;gap:6px;padding:4px 8px;margin:1px 0;cursor:pointer;white-space:nowrap;user-select:none;border-radius:6px;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-node:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dside-node.sel{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);}',
      '.dside-node-icon{flex:none;font-size:13px;}',
      '.dside-node-name{overflow:hidden;text-overflow:ellipsis;}',
      '.dside-node-loading{color:var(--dsw-alias-label-tertiary);padding:3px 8px;font-size:12px;}',
      // ── 反悔药：工作区快照面板（列表行 / 状态栏入口）──
      '.dside-snap-body{overflow:auto;max-height:62vh;}',
      '.dside-snap-row{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;}',
      '.dside-snap-row:last-child{border-bottom:none;}',
      '.dside-snap-row:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dside-snap-time{flex:none;font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-primary);}',
      '.dside-snap-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);}',
      '.dside-snap-delta{flex:none;font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-tertiary);}',
      '.dside-snap-store{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;}',
      '.dside-snapstat{cursor:pointer;}',
      '.dside-snapstat.on{color:var(--dsw-alias-state-business-primary);}',   // 终端开着时状态栏那个开关是亮的
      '.dside-snapstat:hover{color:var(--dsw-alias-label-primary);}',
      // 树形结构：折叠箭头（twistie）+ 缩进参考线 —— 几何照 VSCode 官方 tree.css：
      // twistie 固定 16px 居中；参考线每层一个 1px 竖条，条宽 = 每层缩进量（本应用 14px）。
      // ⚠ 三个容易踩的细节（都是探针量出来的）：① 参考线要 box-sizing:border-box，否则 1px 边框
      //    把每层撑成 15px，逐层累积越错越多；② 参考线 + 箭头必须包在同一个 .dside-lead 里，
      //    否则行上的 flex gap:6px 会把箭头列推右 6px，线就对不齐上一层的箭头列；
      //    ③ 行有 4px 内边距 + 1px 外边距，参考线要 margin:-5px 0 撑满整行，不然线是断的。
      '.dside-lead{flex:none;display:flex;align-items:stretch;align-self:stretch;margin:-5px 0;}',
      '.dside-guide{flex:none;box-sizing:border-box;width:14px;border-left:1px solid var(--dsw-alias-border-l3);}',
      '.dside-twist{flex:none;width:16px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);}',
      '.dside-node:hover .dside-twist,.dside-node.sel .dside-twist{color:var(--dsw-alias-label-primary);}',
      '.dside-twist svg{display:block;}',
      '.dside-chev.collapsed{transform:rotate(-90deg);}',
      '.dside-editor{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;}',
      '.dside-editor-tabs{flex:none;display:flex;align-items:center;height:36px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dside-tablist{flex:1;display:flex;align-items:stretch;height:36px;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;}',
      '.dside-tab{position:relative;flex:none;display:flex;align-items:center;gap:6px;max-width:200px;min-width:0;height:100%;padding:0 6px 0 10px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;border-right:1px solid var(--dsw-alias-border-l1);white-space:nowrap;user-select:none;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dside-tab.active{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}',
      '.dside-tab.active::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--dsw-alias-state-business-primary);}',
      '.dside-tab-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;}',
      '.dside-tab-close{flex:none;width:16px;height:16px;display:flex;align-items:center;justify-content:center;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1;cursor:pointer;opacity:0;transition:opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out),background var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-tab:hover .dside-tab-close{opacity:1;}',
      '.dside-tab-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      // 标签三件套（2026-09-21）：预览标签的名字用斜体（VSCode 同款提示"这只是临时预览"）；
      // 固定标签默认外观与普通标签相同（VSCode 的 pinnedTabSizing='normal'），
      // 只有开了「固定标签收窄成图标」（compact）才只留图标。
      '.dside-tab.preview .dside-tab-name{font-style:italic;}',
      '.dside-tab.pinned .dside-tab-name{}',
      '.dside-tab.pinned.compact{max-width:60px;padding:0 6px;gap:4px;}',
      '.dside-tab.pinned.compact .dside-tab-name{display:none;}',
      '.dside-tab-icon{flex:none;font-size:12px;line-height:1;}',
      '.dside-tab-unpin{flex:none;width:16px;height:16px;display:flex;align-items:center;justify-content:center;border:none;border-radius:4px;background:transparent;font-size:10px;line-height:1;cursor:pointer;opacity:0;transition:opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-tab:hover .dside-tab-unpin{opacity:1;}',
      '.dside-tab-unpin:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dside-editor-meta{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;padding:0 4px;}',
      '.dside-editor-tabs .dside-btn{margin-right:10px;flex:none;}',
      '.dside-agent-title{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dside-editor-body{flex:1;overflow:hidden;min-height:0;background:var(--dsw-alias-bg-base);display:flex;flex-direction:column;}',
      '.dside-editor-error{padding:24px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;}',
      '.dside-editor-host{flex:1;min-height:0;position:relative;}',
      '.dside-editor-monaco{position:absolute;inset:0;}',
      // ── 媒体预览（2026-09-23 用户要求"跟 VSCode 一样能看图"）────────────────────
      // 几何与配色照 VSCode 内置 media-preview 的 imagePreview.css，但**底色/边框走 --dsw-* token**
      //（我们全量 GUI 禁硬编码色；VSCode 那边是 webview 里的 vscode-* 变量，同一套语义）。
      '.dside-media{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:auto;background:var(--dsw-alias-bg-base);z-index:3;}',
      '.dside-media-img{display:block;margin:auto;border:1px solid var(--dsw-alias-border-l2);}',
      // 透明像素的棋盘格（VSCode imagePreview.css 的 conic-gradient；深色底用更暗的格子）
      '.dside-media-img{background-size:16px 16px;background-image:conic-gradient(#141414 25%,transparent 25% 50%,#141414 50% 75%,transparent 75%);}',
      '.dside-media-img.fit{max-width:calc(100% - 20px);max-height:calc(100% - 20px);object-fit:contain;}',
      '.dside-media-img.pixelated{image-rendering:pixelated;}',
      '.dside-media.ready.zoom-in .dside-media-img{cursor:zoom-in;}',
      '.dside-media.ready.zoom-out .dside-media-img{cursor:zoom-out;}',
      '.dside-media-audio,.dside-media-video{max-width:calc(100% - 32px);outline:none;}',
      '.dside-media-bar{position:absolute;top:8px;right:12px;z-index:4;display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:8px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 4px 14px rgba(0,0,0,.24);font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dside-media-bar button{cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;padding:3px 6px;border-radius:5px;font-family:inherit;}',
      '.dside-media-bar button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dside-media-bar .dside-media-zoom{min-width:52px;text-align:center;cursor:pointer;padding:3px 4px;border-radius:5px;user-select:none;}',
      '.dside-media-bar .dside-media-zoom:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dside-media-dim{color:var(--dsw-alias-label-tertiary);padding:0 2px;white-space:nowrap;}',
      '.dside-media-msg{display:flex;flex-direction:column;align-items:center;gap:12px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7;}',
      '.dside-media-msg b{color:var(--dsw-alias-label-primary);font-weight:600;}',
      // 二进制占位卡（VSCode 的 Binary Viewer：图标 + 一句说明 + Open Anyway 按钮）
      '.dside-binary{position:absolute;inset:0;z-index:3;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-base);}',
      '.dside-binary-card{display:flex;flex-direction:column;align-items:center;gap:14px;max-width:min(560px,80%);text-align:center;}',
      '.dside-binary-card .dside-binary-icon{font-size:22px;color:var(--dsw-alias-state-warn-primary, #cca700);}',
      '.dside-binary-card .dside-binary-text{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.8;}',
      '.dside-binary-card .dside-binary-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;word-break:break-all;}',
      // ── 内置浏览器（2026-09-30）：工具栏留在 DOM，页面本体是壳里的原生视图 ─────────────
      // 布局要点：工具栏必须在**视图矩形之外**（原生层会吃掉它范围内的所有点击）；
      // z-index 3 = 与媒体预览同级、低于差异审阅浮层(8)。
      '.dside-browser{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);}',
      '.dside-browser-bar{flex:none;display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}',
      '.dside-browser-btn{flex:none;width:24px;height:22px;display:flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;font-family:inherit;}',
      '.dside-browser-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dside-browser-btn:disabled{opacity:.35;cursor:default;}',
      // 开关处于"开"的状态要看得出来（幻影那颗 👻）
      '.dside-browser-btn.on{background:var(--dsw-alias-state-business-primary);color:#fff;}',
      '.dside-browser-url{flex:1;min-width:80px;height:24px;padding:0 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);font-size:12px;outline:none;}',
      '.dside-browser-url:focus{border-color:var(--dsw-alias-state-business-primary);}',
      // 原生视图的占位块：视图被浮层压住/标签切走时，这里露出"藏起来之前那张截图"，不至于闪白
      '.dside-browser-view{flex:1;min-height:0;position:relative;overflow:hidden;background:var(--dsw-alias-bg-base);}',
      '.dside-browser-shot{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top left;}',
      '.dside-browser-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;}',
      '.dside-browser-empty-big{color:var(--dsw-alias-label-secondary);font-size:13px;}',
      '.dside-browser-empty-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.7;max-width:min(520px,84%);word-break:break-all;}',
      '.dside-tab-globe{flex:none;font-size:10px;line-height:1;}',
      // ⑥ 外部改动提示条（tab 条下方整条通栏）+ 差异审阅浮层
      '.dside-extbar{flex:none;display:flex;align-items:center;gap:8px;padding:5px 10px;font-size:11px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);}',
      '.dside-extbar.warn{color:var(--dsw-alias-state-warn-primary);}',
      '.dside-extbar.err{color:var(--dsw-alias-state-error-primary);}',
      // ⑤ 缺口提示条：Agent 对这个语言还没装代码导航（跟外部改动提示条同一套横条，只换语气色）
      '.dside-extbar.nav{color:var(--dsw-alias-state-business-primary);}',
    // ⑤ 问题面板
    '.dside-problems-list{max-height:52vh;overflow:auto;padding:4px 0 8px;}',
    '.dside-problem-file{padding:8px 14px 2px;color:var(--dsw-alias-label-tertiary);font-size:11px;}',
    '.dside-problem{display:flex;gap:8px;align-items:baseline;padding:4px 14px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary);}',
    '.dside-problem:hover{background:var(--dsw-alias-interactive-bg-hover);}',
    '.dside-problem-sev{width:12px;flex:none;}',
    '.dside-problem.error .dside-problem-sev{color:var(--dsw-alias-state-error-primary);}',
    '.dside-problem.warn .dside-problem-sev{color:var(--dsw-alias-state-warning-primary, #cca700);}',
    '.dside-problem-pos{flex:none;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);}',
    '.dside-problem-msg{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dside-palette-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;}',
    '.dside-statusbar .dside-prob{cursor:pointer;}',
    '.dside-statusbar .dside-prob:hover{color:var(--dsw-alias-label-primary);}',
    '.dside-statusbar .dside-prob.err{color:var(--dsw-alias-state-error-primary);}',
    // ⑫ 文件树右键菜单 + 命名对话框
    '.dside-menu-backdrop{position:fixed;inset:0;z-index:59;}',
    '.dside-menu{position:fixed;z-index:60;min-width:176px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.28);padding:4px;}',
    '.dside-menu-item{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:6px 10px;border-radius:6px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;}',
    '.dside-menu-item.disabled{color:var(--dsw-alias-label-tertiary);cursor:default;}',
    '.dside-menu-item.disabled:hover{background:transparent;}',
    '.dside-menu-keys{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;}',
    '.dside-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover);}',
    '.dside-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1);}',
    '.dside-dialog{width:min(460px,86vw);}',
    '.dside-dialog-body{padding:10px 14px 14px;}',
    '.dside-dialog-body input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);}',
    '.dside-dialog-row{display:flex;gap:8px;justify-content:flex-end;margin-top:12px;}',
    // ⑫ A2/A3 搜索面板：开关行 + 替换行
    '.dside-search-opts{display:flex;align-items:center;gap:6px;padding:6px 14px 2px;}',
    '.dside-opt{padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:11px;cursor:pointer;user-select:none;}',
    '.dside-opt:hover{background:var(--dsw-alias-interactive-bg-hover);}',
    '.dside-opt.on{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:#fff;}',
    '.dside-search-rep{margin-left:auto;padding:1px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;flex:none;}',
    '.dside-search-rep:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
    '.dside-search-reprow{padding-top:0;}',
    // ⑬ 集成终端面板（底部，VSCode Ctrl+` 同款位置）
    // ⚠ 备用键位 Ctrl+J 的出处：VSCode 源码 `workbench.action.togglePanel` 默认键位就是
    //   `KeyMod.CtrlCmd | KeyCode.KeyJ`（panelActions.ts 的 TogglePanelAction）；天工的底部面板
    //   就是终端，所以两者等价 —— 而且字母键在中文输入法 / 某些键盘布局下比反引号更稳。
    '.dside-centercol{flex:1;min-width:0;display:flex;flex-direction:column;}',
    // 中面板视图切换（编辑器 ↔ 快捷键设置）。编辑器**不卸载**（monaco 模型/未保存缓冲区都在它身上），
    // 只是绝对定位藏起来 —— 卸载会丢未保存内容（这是绝不能有的副作用）。
    '.dside-center-body{flex:1;min-height:0;position:relative;display:flex;flex-direction:column;}',
    '.dside-center-editor{flex:1;min-height:0;display:flex;flex-direction:column;}',
    '.dside-center-editor.hidden{position:absolute;inset:0;visibility:hidden;pointer-events:none;}',
    '.dside-settings{position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);overflow:hidden;}',
    '.dside-settings>*{flex:1;min-height:0;}',
    '.dside-keys{position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);}',
    // ── Markdown 文档预览（2026-10-14）：左目录 + 右正文 ────────────────────
    // z-index 4 = 盖住 monaco（3 那档是媒体/浏览器预览），仍低于差异审阅浮层(8)。
    '.dside-mdpane{position:absolute;inset:0;z-index:4;display:flex;background:var(--dsw-alias-bg-base);}',
    '.dside-mdpane-toc{flex:none;width:236px;min-width:0;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}',
    '.dside-mdpane-toc-title{flex:none;padding:10px 12px 6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);}',
    '.dside-mdpane-toc-list{flex:1;min-height:0;overflow:auto;padding:0 8px 12px;}',
    '.dside-toc-item{display:block;width:100%;text-align:left;padding:3px 8px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:1.6;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dside-toc-item.lv1{font-weight:600;color:var(--dsw-alias-label-primary);}',
    '.dside-toc-item.lv3{padding-left:20px;}',
    '.dside-toc-item.lv4{padding-left:32px;}',
    '.dside-toc-item.lv5{padding-left:44px;}',
    '.dside-toc-item.lv6{padding-left:56px;}',
    '.dside-toc-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
    '.dside-toc-item.on{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);}',
    '.dside-mdpane-body{flex:1;min-width:0;overflow:auto;padding:18px 26px 48px;}',
    '.dside-mdpane-doc{max-width:880px;margin:0 auto;font-size:14px;line-height:1.7;}',
    '.dside-mdpane-msg{padding:24px;color:var(--dsw-alias-label-tertiary);font-size:13px;}',
    '.dside-mdpane-toc-empty{padding:10px 12px;color:var(--dsw-alias-label-quaternary);font-size:12px;line-height:1.7;}',
    '.dside-keys-head{flex:none;display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
    '.dside-keys-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);flex:none;}',
    '.dside-keys-search{flex:1;min-width:80px;max-width:420px;height:26px;padding:0 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;outline:none;}',
    '.dside-keys-search:focus{border-color:var(--dsw-alias-state-business-primary);}',
    '.dside-keys-tip{flex:none;padding:6px 12px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}',
    '.dside-keys-body{flex:1;min-height:0;overflow:auto;padding:8px 12px 24px;}',
    '.dside-keys-group{margin-bottom:14px;}',
    '.dside-keys-group-title{font-size:11px;font-weight:600;letter-spacing:.4px;color:var(--dsw-alias-label-tertiary);padding:4px 2px 6px;text-transform:uppercase;}',
    '.dside-keys-item{border-bottom:1px solid var(--dsw-alias-border-l1);}',
    '.dside-keys-row{display:flex;align-items:center;gap:12px;padding:6px 4px;}',
    '.dside-keys-row:hover{background:var(--dsw-alias-interactive-bg-hover);}',
    '.dside-keys-row.rec{background:var(--dsw-alias-interactive-bg-hover);}',
    '.dside-keys-name{flex:1;min-width:0;display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-primary);}',
    '.dside-keys-tag{flex:none;font-size:10px;padding:1px 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);}',
    '.dside-keys-tag.mod{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);}',
    '.dside-keys-bind{flex:none;display:flex;align-items:center;gap:5px;min-width:190px;justify-content:flex-end;}',
    '.dside-keys-none{font-size:11px;color:var(--dsw-alias-label-tertiary);}',
    '.dside-kbd{font-family:var(--ds-font-family-code);font-size:11px;padding:2px 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);white-space:nowrap;}',
    '.dside-kbd.dim{opacity:.55;}',
    '.dside-keys-act{flex:none;display:flex;align-items:center;gap:6px;min-width:112px;justify-content:flex-end;}',
    '.dside-keys-warn{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 4px 8px;font-size:11px;color:var(--dsw-alias-state-warn-primary);}',
    // 【编辑器设置】页（复用 .dside-keys-* 的头部/提示条，正文自己一套）
    '.dside-eset{position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);}',
    '.dside-eset-body{flex:1;min-height:0;overflow:auto;padding:10px 12px 28px;}',
    '.dside-eset-group-title{font-size:11px;font-weight:600;letter-spacing:.4px;color:var(--dsw-alias-label-tertiary);padding:6px 2px 8px;}',
    '.dside-eset-row{display:flex;align-items:flex-start;gap:14px;padding:9px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
    '.dside-eset-row:hover{background:var(--dsw-alias-interactive-bg-hover);}',
    '.dside-eset-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}',
    '.dside-eset-label{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-primary);}',
    '.dside-eset-icon{flex:none;}',
    '.dside-eset-desc{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary);}',
    '.dside-eset-key{font-family:var(--ds-font-family-code);font-size:10px;color:var(--dsw-alias-label-tertiary);}',
    '.dside-eset-row .dside-toggle{flex:none;margin-top:2px;}',
    // 【Agent 设置】页（复用 .dside-eset 外壳；文本框给固定起步高度、可手动拉高，
    // 不撑满整屏 —— 撑满会变成一根顶天立地的大黑柱，2026-10-20 用户当场否掉）
    '.dside-rules .dside-eset-body{display:flex;flex-direction:column;overflow:auto;padding:10px 18px 16px;}',
    '.dside-rules-note{flex:none;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary);padding:0 2px 8px;}',
    '.dside-rules-input{flex:none;width:100%;min-height:220px;max-height:56vh;box-sizing:border-box;resize:vertical;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);font-size:13px;line-height:1.7;outline:none;}',
    '.dside-rules-input:focus{border-color:var(--dsw-alias-state-business-primary);}',
    '.dside-rules-input::placeholder{color:var(--dsw-alias-label-quaternary);}',
    '.dside-rules-foot{flex:none;display:flex;align-items:center;gap:10px;padding:8px 2px 0;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
    '.dside-rules-foot .grow{flex:1;min-width:0;}',
    '.dside-rules-foot .dside-btn:disabled{opacity:.45;cursor:default;}',
    '.dside-term{height:260px;flex:none;box-sizing:border-box;position:relative;display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);}',
    '.dside-term-head{height:30px;flex:none;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);}',
    '.dside-term-head .ttl{font-weight:600;color:var(--dsw-alias-label-primary);flex:none;}',
    '.dside-term-head .st{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px;}',
    '.dside-term-body{flex:1;min-height:0;padding:4px 6px 2px;overflow:hidden;}',
    // ── 面板内的标签栏 + 「Agent幻影」键盘映射面板（第三期，2026-10-08）────────────
    '.dside-term-tabs{flex:none;display:flex;align-items:center;gap:2px;}',
    '.dside-term-tab{display:flex;align-items:center;gap:5px;height:22px;padding:0 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:12px;line-height:1;cursor:pointer;}',
    '.dside-term-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
    '.dside-term-tab.on{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);}',
    '.dside-term-head .dside-dot{margin-left:1px;}',
    '.dside-snapstat .dside-dot{display:inline-block;margin-left:5px;vertical-align:middle;}',
    '.dside-kbpanel{flex:1;min-height:0;display:flex;gap:16px;padding:10px 12px;overflow:auto;background:var(--dsw-alias-bg-base);}',
    '.dside-kbpanel-left{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;justify-content:center;}',
    '.dside-kbrow{display:flex;gap:5px;flex-wrap:wrap;}',
    '.dside-kbd.kb{min-width:26px;height:24px;display:flex;align-items:center;justify-content:center;padding:0 6px;font-size:11px;box-sizing:border-box;}',
    '.dside-kbd.kb.wide{min-width:48px;}',
    // 亮起来的键帽：品牌色 + 一圈光晕，扫一眼就知道"它刚按了哪个键"
    '.dside-kbd.kb.on{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff;box-shadow:0 0 0 2px rgba(59,130,246,.28);}',
    '.dside-kbpanel-right{flex:none;width:min(280px,36%);display:flex;flex-direction:column;gap:6px;border-left:1px solid var(--dsw-alias-border-l1);padding-left:14px;min-height:0;}',
    '.dside-kbpanel-title{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;}',
    '.dside-kbpanel-hint{color:var(--dsw-alias-label-quaternary);font-size:11px;line-height:1.8;}',
    '.dside-kbstream{display:flex;flex-wrap:wrap;gap:4px;overflow:auto;align-content:flex-start;}',
    '.dside-kbchip{font-family:var(--ds-font-family-code);font-size:11px;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
    '.dside-kbchip.now{background:var(--dsw-alias-state-business-primary);color:#fff;}',
      '.dside-extbar .msg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dside-extbar .sp{flex:1;}',
      // ⑥ 差异标签（改动审阅的正文，2026-10-10 重做）：工具栏 + 占满剩余高度的左右 diff
      '.dside-review{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);}',
      '.dside-review-head{flex:none;display:flex;align-items:center;gap:8px;padding:5px 10px;font-size:11px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dside-review-head b{color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.dside-review-head .hint{color:var(--dsw-alias-label-tertiary);}',
      '.dside-review-head .sp{flex:1;}',
      '.dside-review-body{flex:1;min-height:0;}',
      // 块上的保留/撤销按钮条（monaco content widget 里的 DOM：得浮在文本之上才点得到）
      // width:max-content 别删：content widget 的容器不给宽度，不给它就会把两个按钮挤成竖排
      '.dside-hunk-acts{display:flex;flex-wrap:nowrap;align-items:center;gap:6px;width:max-content;padding:2px 6px;pointer-events:auto;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;}',
      // ⚠ 别删：这版 monaco 的 `.contentWidgets` 没设 z-index，它和 `.view-lines` 同在 `.lines-content` 里，
      // 结果是块上的按钮被文本层压住 —— 真人鼠标点下去命中 `view-lines`（2026-10-10 实测）。
      '.dside-review-body .contentWidgets{z-index:5;}',
      // 改动导航（照 VSCode 的 chat 改动审阅：右下角浮动，带"第几处 / 共几处"）
      '.dside-review-nav{position:absolute;right:24px;bottom:24px;z-index:4;display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 2px 8px rgba(0,0,0,0.18);}',
      '.dside-review-nav .cnt{font-size:11px;color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);}',
      '.dside-diff{position:absolute;inset:0;z-index:8;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);}',
      '.dside-diff-head{flex:none;display:flex;align-items:center;gap:10px;padding:7px 11px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dside-diff-head b{color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.dside-diff-head .file{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:34%;color:var(--dsw-alias-label-primary);}',
      '.dside-diff-head .sp{flex:1;}',
      '.dside-diff-body{flex:1;min-height:0;position:relative;}',
      '.dside-diff-monaco{position:absolute;inset:0;}',
      // ⑥ 第二刀：待处理改动清单（Agent 面板内；2026-10-19 起跨轮合并，见下方分组段）
      '.dside-changes{flex:none;max-height:34%;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}',
      '.dside-changes-head{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dside-changes-head b{color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.dside-changes-head .sp{flex:1;}',
      '.dside-change{display:flex;align-items:center;gap:6px;padding:3px 10px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;}',
      '.dside-change:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dside-change-icon{flex:none;width:12px;text-align:center;color:var(--dsw-alias-state-business-primary);}',
      '.dside-change-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;color:var(--dsw-alias-label-primary);}',
      '.dside-change-diff{flex:none;font-family:var(--ds-font-family-code);font-size:10px;}',
      '.dside-change-diff .add{color:var(--dsw-alias-state-success-primary);margin-right:4px;}',
      '.dside-change-diff .del{color:var(--dsw-alias-state-error-primary);}',
      '.dside-change-tag{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary);}',
      // 行尾动作：默认隐身，鼠标移上去才显形（VSCode 的改动列表就是 hover 才出现 Keep/Undo）
      '.dside-change-acts{flex:none;display:flex;gap:4px;opacity:0;}',
      '.dside-change:hover .dside-change-acts{opacity:1;}',
      // ⑥ 第三刀：改动历史（按轮次分组）+ 多文件审阅队列
      '.dside-round{display:flex;align-items:center;gap:6px;padding:4px 10px;background:var(--dsw-alias-bg-layer-3);border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      '.dside-round b{color:var(--dsw-alias-label-secondary);font-weight:600;}',
      '.dside-round.now b{color:var(--dsw-alias-label-primary);}',
      '.dside-round .sp{flex:1;}',
      '.dside-changes-head .link{flex:none;border:none;background:none;padding:0;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:11px;cursor:pointer;}',
      '.dside-changes-note{padding:2px 10px 6px;font-size:10px;color:var(--dsw-alias-label-tertiary);}',
      '.dside-diff-chips{flex:none;display:flex;align-items:center;gap:6px;padding:5px 11px;overflow-x:auto;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dside-chip{flex:none;display:flex;align-items:center;gap:5px;padding:2px 9px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer;white-space:nowrap;}',
      // ⑥ 第四刀：浮层里的「改动块」横条（逐块保留 / 撤销）
      '.dside-hunks{flex:none;display:flex;align-items:center;gap:6px;padding:5px 11px;overflow-x:auto;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dside-hunks-label{flex:none;margin-right:2px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dside-hunk{flex:none;display:flex;align-items:center;gap:5px;padding:1px 8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;}',
      '.dside-hunk .idx{font-family:var(--ds-font-family-code);font-size:10px;color:var(--dsw-alias-label-primary);}',
      //（横条里处理过的块直接退场，所以没有 .kept / .undone / .tag 这些终态样式）

      '.dside-chip:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dside-chip.active{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);}',
      '.dside-chip.undone{text-decoration:line-through;color:var(--dsw-alias-label-tertiary);}',
      '.dside-editor-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);z-index:2;font-size:12px;}',
      // ⑥ 问 Agent 的行内输入条（浮在编辑器上方；VSCode Ctrl+I 的位置感）
      '.dside-ask{position:absolute;top:10px;left:50%;transform:translateX(-50%);width:min(680px,94%);z-index:6;display:flex;flex-direction:column;gap:7px;padding:9px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 10px 28px rgba(0,0,0,.38);}',
      '.dside-ask-ctx{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;white-space:nowrap;}',
      '.dside-ask-ctx b{flex:none;color:var(--dsw-alias-label-secondary);font-weight:600;}',
      '.dside-ask-file{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dside-ask-diag{flex:none;padding:1px 7px;border-radius:9px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.dside-ask-row{display:flex;gap:6px;align-items:center;}',
      '.dside-ask-input{flex:1;min-width:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 9px;font:inherit;font-size:13px;}',
      '.dside-ask-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);}',
      '.dside-ask-hint{font-size:11px;color:var(--dsw-alias-state-warn-primary);}',
      '.dside-dot{flex:none;width:8px;height:8px;border-radius:50%;background:transparent;}',
      '.dside-dot.dirty{background:var(--dsw-alias-state-warn-primary);}',
      // 右侧面板宽度：2026-09-17 用户要求「增加一倍」→ 352 → 704px（max-width 兜底：
      // 窗口拖窄时不让它把编辑器挤没，窗口默认 1500 宽，60vw=900 平时不生效）
      '.dside-side{width:704px;flex:none;box-sizing:border-box;position:relative;background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0;}',
      // 2026-09-21 用户要求：右侧不再有「Agent 助手 / 插件」标签栏，永远 Agent 面板（插件搬到左侧活动栏）
      // 标签栏下方的操作栏（2026-09-17 用户要求：「新对话」按钮放这儿）
      '.dside-side-actions{flex:none;display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dside-side-actions-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:right;}',
      '.dside-agent-head{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dside-agent-select{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:3px 6px;font:inherit;}',
      '.dside-badge{flex:none;font-size:11px;padding:2px 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);}',
      '.dside-badge.idle{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}',
    // ⑭ 长任务进度条（跑的时候显示：第 N 步 · 已用 · 正在做什么）
    '.dside-agent-progress{flex:none;display:flex;align-items:center;gap:10px;padding:5px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary);}',
    '.dside-agent-progress .what{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);}',
    '.dside-agent-progress .hint{flex:none;color:var(--dsw-alias-label-tertiary);}',
      '.dside-badge.running{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary);border-color:transparent;}',
      '.dside-agent-messages{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:12px;min-height:0;}',
      '.dside-msg{max-width:88%;padding:8px 12px;border-radius:14px;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;box-shadow:0 1px 2px rgba(0,0,0,.12);}',
      '.dside-msg.user{align-self:flex-end;background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);}',
      '.dside-msg.assistant{align-self:flex-start;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);}',
      // Markdown 渲染区（平台 MarkdownText 自带 CSS module 样式，这里只做"放进气泡"的适配）：
      // 气泡是 white-space:pre-wrap（纯文本时代留下的），markdown 块必须重置回 normal，
      // 否则源码换行会和块级元素叠加成大段空白。
      '.dside-md{white-space:normal;word-break:break-word;overflow-wrap:anywhere;}',
      '.dside-md-fallback{white-space:pre-wrap;}',
      '.dside-md p{margin:0 0 .5em;}',
      '.dside-md p:last-child,.dside-md ul:last-child,.dside-md ol:last-child,.dside-md pre:last-child{margin-bottom:0;}',
      '.dside-md ul,.dside-md ol{margin:.3em 0 .5em;padding-left:1.5em;}',
      '.dside-md li{margin:.15em 0;}',
      '.dside-md h1,.dside-md h2,.dside-md h3,.dside-md h4,.dside-md h5{margin:.7em 0 .35em;line-height:1.35;font-size:1.1em;}',
      '.dside-md h1:first-child,.dside-md h2:first-child,.dside-md h3:first-child{margin-top:0;}',
      '.dside-md pre{overflow:auto;max-width:100%;font-size:11px;}',
      '.dside-md code{font-family:var(--ds-font-family-code);}',
      '.dside-md table{border-collapse:collapse;font-size:11px;max-width:100%;}',
      '.dside-md blockquote{margin:.4em 0;padding-left:.7em;border-left:2px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);}',
      '.dside-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l2);margin:.7em 0;}',
      '.dside-md a{color:var(--dsw-alias-state-business-primary);}',
      '.dside-msg-time{display:block;margin-top:4px;font-size:10px;opacity:.6;}',
      '.dside-agent-empty{color:var(--dsw-alias-label-tertiary);text-align:center;padding:24px 8px;font-size:12px;}',
      '.dside-agent-input{flex:none;display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
      '.dside-agent-input textarea{flex:1;min-height:58px;max-height:140px;resize:vertical;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:9px 11px;font:inherit;outline:none;transition:border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),box-shadow var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-agent-input textarea:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-alias-state-business-tertiary);}',
      '.dside-agent-input textarea:disabled{opacity:.5;}',
      // ── 平台原生会话（右侧面板里挂的是平台那棵槽树，见 §3「平台会话接入」）──
      '.dside-agent-wrap{display:flex;flex-direction:column;flex:1;min-height:0;}',
      '.dside-agent-platform{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;}',
      // ⑯ 输入框永远贴底（2026-09-21 用户要求："chat 面板那个对话框应该放到底部，不管有没有发送消息"）。
      // 平台在 hero（空会话/新对话）阶段把「hero 标题 + 工作区行 + 输入卡」整叠**垂直居中**
      // （ui-conversation 的 ConversationRoot.module.css：`.root[data-phase='hero'] .scrollBody{justify-content:center}`
      //  + `.composerHero{padding-bottom:32px}`），发过消息的 active 阶段才是贴底（sticky bottom:0）。
      // 这里把 hero 阶段也按贴底排：选择器**只用平台自己的 data 属性**（data-phase / data-conversation-scroll /
      // data-composer-seat），不碰 CSS-module 哈希 —— 平台哪天改了结构，最坏结果是"又回到居中"，不会坏。
      '.dside-agent-platform [data-phase="hero"] [data-conversation-scroll]{justify-content:flex-end;}',
      '.dside-agent-platform [data-phase="hero"] [data-composer-seat]{margin-top:auto;}',
      // hero 的那 32px 是"居中悬浮"用的，贴底后跟 active 阶段的下边距对齐（12px，与输入卡自身下沿一致）
      '.dside-agent-platform [data-phase="hero"] [data-composer-seat] > *{padding-bottom:12px;}',
      // 平台的 frame-wide 浮层：click-through 层，条目自己 opt-in（照 AppFrame.overlayLayer）
      '.dside-overlay-layer{position:fixed;inset:0;z-index:20;pointer-events:none;}',
      '.dside-overlay-layer > *{pointer-events:auto;}',
      // ── 会话列表（官方 sessions.list 数据）──────────────────
      '.dside-sessions{flex:none;max-height:148px;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l1);padding:6px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:1px;}',
      '.dside-session{display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:8px;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-session:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dside-session.on{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);}',
      '.dside-session-dot{width:8px;height:8px;border-radius:50%;flex:none;}',
      '.dside-session-dot.idle{background:var(--dsw-alias-state-success-primary);}',
      '.dside-session-dot.running{background:var(--dsw-alias-state-warn-primary);}',
      '.dside-session-title{flex:1;overflow:hidden;text-overflow:ellipsis;}',
      '.dside-session-time{font-size:10px;opacity:.7;}',
      '.dside-session-empty{padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary);}',
      // 历史对话（2026-09-17 用户要求：默认收起 + 顶部搜索 + 命中片段）
      '.dside-sessions-head{display:flex;align-items:center;gap:6px;padding:2px 4px 7px;}',
      '.dside-sessions-search{flex:1;min-width:0;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 9px;font:inherit;font-size:11px;outline:none;transition:border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-sessions-search:focus{border-color:var(--dsw-alias-state-business-primary);}',
      '.dside-session.res{flex-direction:column;align-items:stretch;gap:2px;}',
      '.dside-session-snippet{font-size:10px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      // 命中词高亮（历史对话搜索）：绿字 + 浅绿底，随明暗主题自动换色
      '.dside-hit{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary);border-radius:3px;padding:0 2px;}',
      '.dside-session.res:hover .dside-session-snippet{color:var(--dsw-alias-label-secondary);}',
      // ── 工具行 / 思考折叠 / 停止标记 ────────────────────────
      '.dside-toolrow{padding:2px 12px;font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);}',
      '.dside-toolrow.err{color:var(--dsw-alias-state-error-primary);}',
      '.dside-reason-toggle{border:none;background:none;color:var(--dsw-alias-label-tertiary);font-size:10px;cursor:pointer;padding:2px 0;}',
      '.dside-reason-toggle:hover{color:var(--dsw-alias-label-secondary);}',
      '.dside-reason-body{margin:4px 0;padding:6px 8px;background:var(--dsw-alias-bg-base);border-left:2px solid var(--dsw-alias-border-l3);border-radius:4px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;}',
      '.dside-msg.stopped{opacity:.75;border:1px dashed var(--dsw-alias-border-l3);}',
      '.dside-older{align-self:center;margin-bottom:8px;opacity:.8;}',
      '.dside-stop-note{display:block;margin-top:4px;font-size:10px;color:var(--dsw-alias-label-tertiary);}',
      '.dside-msg.partial{opacity:.85;}',
      '.dside-plugins{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px;min-height:0;}',
      '.dside-plugin{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;box-shadow:0 1px 2px rgba(0,0,0,.06);}',
      '.dside-plugin-head{display:flex;align-items:center;gap:8px;}',
      '.dside-plugin-name{font-weight:600;color:var(--dsw-alias-label-primary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dside-plugin-badge{flex:none;font-size:10px;padding:1px 8px;border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);}',
      '.dside-plugin-badge.run{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary);border-color:transparent;}',
      '.dside-plugin-badge.stop{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);border-color:transparent;}',
      '.dside-plugin-badge.formal{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);border-color:transparent;}',
      '.dside-plugin-purpose{color:var(--dsw-alias-label-secondary);font-size:11px;margin:6px 0 0;}',
      '.dside-plugin-actions{display:flex;gap:6px;margin-top:8px;}',
      '.dside-plugin-meta{color:var(--dsw-alias-label-tertiary);font-size:10px;margin-top:6px;word-break:break-all;}',
      // 插件面板：全量透明（2026-09-22 用户要求看到后端插件与停用的行）
      '.dside-plugin-filter{display:flex;flex-direction:column;gap:6px;flex:none;}',
      '.dside-plugin-search{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;padding:5px 8px;outline:none;}',
      '.dside-plugin-search:focus{border-color:var(--dsw-alias-state-business-primary);}',
      '.dside-plugin-modes{display:flex;flex-wrap:wrap;gap:4px;}',
      '.dside-plugin-mode{font-size:10px;padding:2px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;}',
      '.dside-plugin-mode.on{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);border-color:transparent;}',
      '.dside-plugin.off{opacity:.62;}',
      '.dside-plugin-badge.pending{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);border-color:transparent;}',
      '.dside-plugin-badge.failed{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}',
      '.dside-plugin-badge.disabled{color:var(--dsw-alias-label-tertiary);}',
      '.dside-plugin-badge.client{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);border-color:transparent;}',
      // 设置 → 代码导航：原来那张卡片（.dside-codenav-*）已撤（会闪，见 settingsBlocks 注释），
      // 现在这格是一行静态说明；「装了哪些语言组件」搬到【编辑器设置】页用 .dside-eset-* 样式显示。
      '.dside-statusbar{height:26px;flex:none;display:flex;align-items:center;gap:16px;padding:0 14px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dside-statusbar .sp{color:var(--dsw-alias-label-tertiary);}',
      // ── ③ 命令面板 / 快速打开 / 全局搜索（overlay）────────────
      '.dside-overlay{position:fixed;inset:0;z-index:4000;background:rgba(0,0,0,.38);display:flex;flex-direction:column;align-items:center;}',
      '.dside-overlay .card{position:relative;top:11vh;width:min(680px,calc(100vw - 120px));background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 14px 44px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;}',
      '.dside-palette-head{flex:none;display:flex;align-items:center;gap:10px;padding:4px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dside-palette-input{flex:1;box-sizing:border-box;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:13px/1.5 var(--dsw-font-family);padding:9px 2px;}',
      '.dside-palette-input::placeholder{color:var(--dsw-alias-label-tertiary);}',
      '.dside-palette-title{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;}',
      '.dside-palette-list{max-height:min(420px,60vh);overflow:auto;padding:6px;}',
      '.dside-palette-item{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;}',
      '.dside-palette-item.sel{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);}',
      '.dside-palette-item-icon{flex:none;width:18px;text-align:center;font-size:12px;opacity:.9;}',
      '.dside-palette-item-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dside-palette-item-detail{flex:none;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:10px;margin-left:8px;}',
      '.dside-overlay-note{padding:18px 10px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;}',
      '.dside-overlay-err{padding:18px 10px;text-align:center;color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap;}',
      '.dside-search-card{position:relative;top:8vh;width:min(780px,calc(100vw - 100px));max-height:80vh;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 14px 44px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;}',
      '.dside-search-head{flex:none;display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.dside-search-input{flex:1;box-sizing:border-box;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 11px;font:inherit;outline:none;transition:border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),box-shadow var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-search-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-alias-state-business-tertiary);}',
      '.dside-search-stat{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;}',
      '.dside-search-body{flex:1;overflow:auto;padding:8px 4px 14px;min-height:140px;}',
      '.dside-search-group{color:var(--dsw-alias-label-secondary);font-size:11px;}',
      '.dside-search-file{display:flex;align-items:baseline;gap:8px;padding:7px 10px 2px;color:var(--dsw-alias-label-secondary);}',
      '.dside-search-file .nm{flex:none;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.dside-search-file .rp{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);}',
      '.dside-search-line{display:flex;align-items:baseline;gap:10px;padding:2px 10px 2px 26px;border-radius:6px;cursor:pointer;font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-search-line:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dside-search-line .ln{flex:none;min-width:36px;text-align:right;color:var(--dsw-alias-label-tertiary);user-select:none;}',
      '.dside-search-line mark{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-primary);border-radius:2px;padding:0 1px;}',
      // ── 界面配色：VSCode 的层次规矩 + 整体压暗一档（2026-09-17 用户选定；A/B 两版已合并）──
      // 参照物 = VSCode 默认深色主题（Dark Modern），色值取自本插件自带的 VSCode 官方主题文件
      // static/themes/dark-modern.json（当初为编辑器买的那份资产，非臆造配色）。
      // 保留 VSCode 的全部"高级感"规矩：
      //   · 层次：内容区最亮、四周 chrome 退暗（VSCode 编辑器 #1F1F1F > 侧栏 #181818）
      //   · 边框细到几乎看不见（VSCode #2B2B2B），不靠灰线分层、靠明度分层
      //   · 文字分三级（#CCCCCC / #9D9D9D / #868686）
      //   · 全站只有一个强调色 #0078D4，只在选中 / 焦点处露一下
      //   · 控件底比 chrome 底亮一档（VSCode 按钮 / 输入框 #313131）
      // 与原色的唯一差异 = 整体再压暗一档（用户嫌 VSCode 原色"偏灰白"）：
      //   四周 chrome #0D0D0F、内容 #141416、控件 #1C1C20、边框 #242428。
      // ⚠ 零渐变、零发光（上一版"蓝调科技感"被否的教训，见 00devCore §6 57）。
      // 编辑器内部底色同步在 static/themes/dark-modern.json（editor.background #141416 等），改色板时两处一起改。
      //
      // ⚠⚠ label-primary-foreground 不是"白字颜色"，是"贴在反色块（主按钮/开关/复选框）上的前景色"：
      //   官方深色主题里 brand-primary 是近白 rgb(249,250,251)，所以这一位官方给的是**近黑**。
      //   2026-10-20 之前这里写的是 #FFFFFF，结果主按钮"白底白字"、开关"白轨道白圆点"——界面里
      //   凡是官方用这对 token 的控件（问答卡片确定、模型设置保存、账号页、反馈 chip）全看不清。
      //   ⇒ 这一位**不覆盖**，交还给官方主题（深色近黑、浅色纯白，都跟着走）。
      //   要"反色块里写白字"就自己写死 #FFFFFF（见 .dside-btn.primary），别动这一位。
      '.dside-root{--dsw-alias-bg-base:#141416;--dsw-alias-bg-layer-1:#0D0D0F;--dsw-alias-bg-layer-2:#0D0D0F;--dsw-alias-bg-layer-3:#17171A;--dsw-alias-bg-overlay:#17171A;--dsw-alias-border-l1:#242428;--dsw-alias-border-l2:#2E2E33;--dsw-alias-border-l3:#3A3A40;--dsw-alias-border-l4:#45454C;--dsw-alias-label-primary:#D6D6D6;--dsw-alias-label-secondary:#9A9AA0;--dsw-alias-label-tertiary:#7C7C84;--dsw-alias-interactive-bg-hover:rgba(255,255,255,.08);--dsw-alias-interactive-bg-active:rgba(255,255,255,.10);--dsw-alias-interactive-bg-hover-danger:rgba(248,81,73,.18);--dsw-alias-state-business-primary:#0078D4;--dsw-alias-state-business-tertiary:rgba(0,120,212,.40);--dsw-alias-button-info-fill:#0078D4;--dsw-alias-button-info-hover:#026EC1;--dsw-static-deepseek-400:#0078D4;--dsw-specific-bubble:#26262B;--dsw-specific-input-major:#1C1C20;--dsw-alias-state-error-primary:#F85149;--dsw-alias-state-warn-primary:#CCA700;--dsw-alias-state-warning-primary:#CCA700;--dsw-alias-state-warn-tertiary:rgba(204,167,0,.22);--dsw-alias-state-success-primary:#2EA043;--dsw-alias-state-success-tertiary:rgba(46,160,67,.22);}',
      // 激活标签：VSCode 是"顶部 1px 蓝线 + 白字"（tab.activeBorderTop / tab.activeForeground）
      '.dside-tab.active{color:#FFFFFF;}',
      '.dside-tab.active::after{top:0;bottom:auto;height:1px;background:#0078D4;}',
      '.dside-tab:hover{background:#141416;}',
      // 控件底：VSCode 里按钮 / 输入框 / 下拉比 chrome 底亮一档（input.background #313131）
      '.dside-btn{background:#1C1C20;border-color:#2E2E33;}',
      '.dside-btn:hover{background:#26262B;border-color:#3A3A40;}',
      '.dside-agent-select{background:#1C1C20;border-color:#2E2E33;}',
      '.dside-chip{background:#1C1C20;border-color:#2E2E33;}',
      '.dside-chip:hover{background:#26262B;}',
      // 助手气泡：VSCode 浮层底（editorWidget.background）+ 发丝边框
      '.dside-msg.assistant{background:#17171A;border:1px solid #242428;}',
      // 聚焦：VSCode 是 1px 蓝框（focusBorder #0078D4），不是大光晕
      '.dside-agent-input textarea:focus{border-color:#0078D4;box-shadow:0 0 0 1px rgba(0,120,212,.45);}',
      // 滚动条：细、半透明灰、不抢眼（VSCode 观感）
      '.dside-root *::-webkit-scrollbar{width:14px;height:14px;}',
      '.dside-root *::-webkit-scrollbar-track{background:transparent;}',
      '.dside-root *::-webkit-scrollbar-thumb{background:rgba(121,121,121,.42);border:3px solid transparent;background-clip:content-box;border-radius:7px;}',
      '.dside-root *::-webkit-scrollbar-thumb:hover{background:rgba(150,150,150,.6);border:3px solid transparent;background-clip:content-box;}',

      // ── 输入区改版（2026-09-17 用户要求）────────────────────────────
      // ① 发送 / 中断按钮放进输入框内部右下角（成熟设计的做法），不再单占一列；
      // ② 去掉 textarea 右下角的缩放手柄（resize:none）；③ 右侧留出按钮位置。
      '.dside-agent-input{display:block;}',
      '.dside-agent-box{position:relative;display:flex;}',
      '.dside-agent-input textarea{resize:none;padding:9px 48px 9px 11px;}',
      '.dside-send{position:absolute;right:7px;bottom:7px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:8px;background:#0078D4;color:#FFFFFF;font-size:13px;line-height:1;cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-send:hover{background:#026EC1;}',
      '.dside-send:disabled{background:#2E2E33;color:#7C7C84;cursor:default;}',
      '.dside-send.stop{background:transparent;border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',

      // ── 标题栏在 Electron 壳里是自绘的（2026-09-17）──────────────────
      // 壳里（has-overlay）隐藏了原生标题栏、用 titleBarOverlay 画系统按钮 → 右侧要留出
      // 系统按钮的位置（约 138px@100%），窗口拖动也交给这条标题栏。
      '.dside-titlebar{-webkit-app-region:drag;}',
      '.dside-titlebar.has-overlay{padding-right:150px;}',
      '.dside-titlebar button,.dside-titlebar .dside-upd{-webkit-app-region:no-drag;}',
      // ── 对话回退：每轮回复末尾一条横线，鼠标移上去才出按钮 ──────────────
      // 横线常驻（用户要看得见"这里是个检查点"），按钮默认藏起来（不然每轮都挂个按钮太吵）。
      '.dside-rewind{position:relative;display:flex;align-items:center;justify-content:center;gap:6px;height:24px;margin:2px 0;}',
      '.dside-rewind-line{position:absolute;left:0;right:0;top:50%;height:1px;background:var(--dsw-alias-border-l2);}',
      '.dside-rewind-btn{position:relative;z-index:1;display:flex;align-items:center;padding:2px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;opacity:0;pointer-events:none;transition:opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out);}',
      '.dside-rewind:hover .dside-rewind-btn,.dside-rewind.armed .dside-rewind-btn{opacity:1;pointer-events:auto;}',
      '.dside-rewind-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3);}',
      '.dside-rewind-btn.armed{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);}',
      '.dside-rewind-btn:disabled{opacity:.65;cursor:default;}',
      '.dside-rewind-x{position:relative;z-index:1;border:none;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer;padding:2px 4px;}',
      '.dside-rewind-x:hover{color:var(--dsw-alias-label-primary);}',
      '.dside-rewind-note{position:relative;z-index:1;font-size:10px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1);padding:0 4px;}',
      // 退完之后那一条：横线 + 「已恢复到检查点」+ 取消（口径：没有重做按钮）
      '.dside-rewind-done{position:relative;z-index:1;font-size:11px;color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-1);padding:0 8px;}',
      '.dside-rewind-btn.show{opacity:1;pointer-events:auto;border-color:var(--dsw-alias-border-l3);}',
      // 对话回退 · 第二段确认弹窗：一句说明 + 会被动到的文件清单
      '.dside-dialog-text{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;}',
      '.dside-dialog-list{margin-top:8px;max-height:150px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 8px;background:var(--dsw-alias-bg-base);}',
      '.dside-dialog-file{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    ].join('\n');
    // 注入：标签已存在则覆盖内容 —— 插件热重载（改样式/回滚样式）后页面能自动跟随，不必手动刷新
    if (typeof document !== 'undefined') {
      var tag = document.querySelector('style[data-plugin="dsh-ide"]');
      if (tag === null) {
        tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-ide';
        document.head.appendChild(tag);
      }
      if (tag.textContent !== css) tag.textContent = css;
    }

    // ── API ──────────────────────────────────────────────────────
    function apiGet(action, params) {
      var q = '';
      if (params) {
        var parts = [];
        for (var key in params) {
          if (params[key] !== undefined && params[key] !== null) {
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
          }
        }
        if (parts.length) q = '?' + parts.join('&');
      }
      return fetch('/dsh-ide' + action + q).then(function (r) { return r.json() }).catch(function () { return { error: 'network' } });
    }
    function apiPost(action, body) {
      return fetch('/dsh-ide' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json() }).catch(function () { return { error: 'network' } });
    }

    // ── 反悔药：自动快照（fire-and-forget，绝不阻塞用户动作）─────────────────
    // 触发点：发消息前（= 一轮 Agent 改动之前的状态）· 保存成功后 · 定时兜底。
    // host 半 3 秒内合并、内容没变则不落新快照，所以这里多点触发不会把快照库撑爆。
    var snapAutoBusy = false;
    function snapAuto(label) {
      if (snapAutoBusy) return;                  // 上一次还在飞就别排队（扫盘是 host 侧的活）
      snapAutoBusy = true;
      apiPost('/snapshot', { label: label, reason: 'auto' }).then(function (r) {
        snapAutoBusy = false;
        if (r && r.ok && !r.coalesced && !r.unchanged && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('dside-snapshot', { detail: { ts: r.ts } }));
        }
      }).catch(function () { snapAutoBusy = false; });
    }
    function snapTimeText(ts) {
      var d = new Date(ts);
      var now = new Date();
      var hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2);
      var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
      return (sameDay ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + hh + ':' + mm;
    }

    // ── 主题呈现（替代 ui-layout 的 ThemePresenter，2026-09-20）───────────────
    // 平台把解析好的主题快照写到 document 上：html color-scheme（原生滚动条/表单控件）、
    // body[data-ds-dark-theme]（平台 token 的暗色皮肤）、内容字号轴、活动主题的 token 覆盖
    // （写成 body 内联变量）。平台组件（会话、输入框、弹层）全靠这一层取色 ——
    // 我们关掉了 ui-layout（原因见 apply 里那段注释），就得自己把它写回去。
    var presentedThemeTokens = [];
    function presentTheme(snapshot) {
      try {
        var active = (snapshot && snapshot.active) || {};
        var scheme = active.colorScheme || 'dark';
        document.documentElement.style.colorScheme = scheme;
        var body = document.body;
        if (!body) return;
        if (scheme === 'dark') body.setAttribute('data-ds-dark-theme', '');
        else body.removeAttribute('data-ds-dark-theme');
        if (typeof snapshot.fontSize === 'number') body.style.setProperty('--dsh-content-font-size', snapshot.fontSize + 'px');
        for (var i = 0; i < presentedThemeTokens.length; i++) body.style.removeProperty(presentedThemeTokens[i]);
        presentedThemeTokens = [];
        var tokens = active.tokens || {};
        for (var name in tokens) {
          body.style.setProperty(name, tokens[name]);
          presentedThemeTokens.push(name);
        }
      } catch (e) { /* 呈现失败不影响 IDE */ }
    }

    // ── 使用轨迹 / 错误日志上报（自动记录，无需用户转述）─────────
    // 批量 POST /dsh-ide/trace → host 半落盘 <DSH_HOME>\logs\ide-trace.log；
    // 开发台 Agent 报障时直接读该文件，不再要求用户口述/复制日志。
    var tracePending = [];
    var traceTimer = null;
    // 诊断计数（报障/E2E 直接读 window.__dshTraceStat 就能判断"客户端到底发没发出去"，
    // 不用猜是 trace() 没调用还是上报链路断了 —— 2026-09-16 第六刀 E2E 吃过这个亏）
    var traceStat = (typeof window !== 'undefined')
      ? (window.__dshTraceStat = window.__dshTraceStat || { queued: 0, sent: 0, failed: 0, lastAt: 0 })
      : { queued: 0, sent: 0, failed: 0, lastAt: 0 };
    // 采集端就盖时间戳：800ms 攒批上报，等到落盘时一批条目会被压成同一毫秒，
    // 事后没法跟引擎日志按时间对齐（2026-10-19 修）。
    function trace(kind, level, msg, meta) {
      try {
        tracePending.push({
          ts: Date.now(),          // 数值型：host 半认这个，落盘时转 ISO
          src: 'client',
          level: level || 'info',
          kind: kind || 'client',
          msg: String(msg || '').slice(0, 2000),
          meta: meta || undefined,
        });
        // 上限与服务端收口对齐（服务端一批收 200）：原来 100 条 + 服务端只收 50 会静默丢一半
        if (tracePending.length > 300) tracePending.shift();
        traceStat.queued += 1;
        if (!traceTimer) traceTimer = setTimeout(flushTrace, 800);
      } catch (e) { /* 记录失败不干扰业务 */ }
    }
    // 高频同类条目合并（窗口内只落第一条，带 suppressed 计数）——
    // 自动刷新/会话落盘这类每几秒来一次的记录，重复一万遍也提供不了任何新信息。
    var traceGates = {};
    function traceEvery(key, windowMs, kind, level, msg, meta) {
      try {
        var now = Date.now();
        var g = traceGates[key];
        if (g && now - g.at < windowMs) { g.n += 1; return; }
        var m = meta ? Object.assign({}, meta) : {};
        if (g && g.n) m.suppressed = g.n;
        traceGates[key] = { at: now, n: 0 };
        trace(kind, level, msg, m);
      } catch (e) { /* 忽略 */ }
    }
    function flushTrace() {
      traceTimer = null;
      var batch = tracePending.splice(0, 200);
      if (!batch.length) return;
      // 补上"在哪"：当前工作空间根与会话 id 由页面在状态变化时写进 __dshTraceCtx，
      // 这样"用户点了什么"能和引擎会话对上号（原来 20 万条里只有 290 条带会话 id）。
      var ctx = (typeof window !== 'undefined' && window.__dshTraceCtx) || null;
      if (ctx) {
        for (var i = 0; i < batch.length; i++) {
          if (ctx.root && batch[i].root === undefined) batch[i].root = ctx.root;
          if (ctx.sessionId && batch[i].sessionId === undefined) batch[i].sessionId = ctx.sessionId;
        }
      }
      traceStat.lastAt = Date.now();
      try {
        fetch('/dsh-ide/trace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ entries: batch }),
          keepalive: true,
        }).then(function (r) {
          if (r && r.ok) traceStat.sent += batch.length;
          else retryTrace(batch);
        }).catch(function () { retryTrace(batch); });
      } catch (e) { retryTrace(batch); }
    }
    // 失败重试一次：后端重启的那几秒原来会把痕迹全丢掉（页面还活着，只是没接上）
    function retryTrace(batch) {
      traceStat.failed += batch.length;
      if (batch.retried) return;
      batch.retried = true;
      if (tracePending.length > 300) return;
      tracePending = batch.concat(tracePending);
      if (!traceTimer) traceTimer = setTimeout(flushTrace, 2000);
    }

    // ── Monaco 加载器（host 半静态托管 min/vs，绕开 bundle 纯度门禁）──
    // 版本锁死 0.56.0（§7 策略：想升级再升）。loader.js 是 AMD loader：
    // editor.main.js 是命名 define 模块，必须走 require(['vs/editor/editor.main'])。
    // 0.56 的 AMD 构建自带 MonacoEnvironment（Blob worker + importScripts
    // assets/*.worker-*.js），无需自己配 worker。
    var MONACO_VER = '0.56.0';
    var MONACO_BASE = '/dsh-ide/monaco/min/vs';
    var monacoPromise = null;
    function loadMonaco() {
      if (monacoPromise) return monacoPromise;
      monacoPromise = new Promise(function (resolve, reject) {
        if (window.monaco) return resolve(window.monaco);
        var script = document.createElement('script');
        script.src = MONACO_BASE + '/loader.js?v=' + MONACO_VER;
        script.onerror = function () {
          monacoPromise = null;
          console.error('[dsh-ide][monaco] loader.js script onerror');
          trace('client', 'error', 'monaco-load-failed', { stage: 'loader-script' });
          reject(new Error('monaco loader 加载失败'));
        };
        script.onload = function () {
          var req = window.require;
          if (!req || typeof req.config !== 'function') {
            monacoPromise = null;
            console.error('[dsh-ide][monaco] AMD require 未就绪');
            trace('client', 'error', 'monaco-load-failed', { stage: 'amd-require' });
            reject(new Error('monaco AMD loader 未就绪'));
            return;
          }
          try {
            req.config({ paths: { vs: MONACO_BASE }, urlArgs: 'v=' + MONACO_VER });
          } catch (e) {
            monacoPromise = null;
            console.error('[dsh-ide][monaco] require.config threw', e);
            trace('client', 'error', 'monaco-load-failed', { stage: 'require-config', error: String((e && e.message) || e) });
            reject(e);
            return;
          }
          req(['vs/editor/editor.main'], function () {
            resolve(window.monaco);
          }, function (err) {
            monacoPromise = null;
            console.error('[dsh-ide][monaco] editor.main require failed', err);
            trace('client', 'error', 'monaco-load-failed', { stage: 'editor-main', error: String((err && err.message) || err || '') });
            reject(err || new Error('monaco editor.main 加载失败'));
          });
        };
        document.head.appendChild(script);
      });
      return monacoPromise;
    }

    function cssVar(name) {
      var v = getComputedStyle(document.body).getPropertyValue(name);
      return (v || '').trim() || undefined;
    }

    // monaco 主题只吃 #rrggbb[aa]；getComputedStyle 会把 token 算成
    // rgb()/rgba()（2026-08-25 踩坑：Illegal value for token color）。
    function rgbToHex(v) {
      // 兼容逗号/空格分隔、百分比、alpha（rgba(1,2,3,.5) / rgb(1 2 3 / 50%)）
      var m = /rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,/]+([\d.]+%?))?\s*\)/i.exec(v);
      if (!m) return undefined;
      function ch(x) {
        if (typeof x !== 'string' || !x.endsWith('%')) return Math.min(255, Math.max(0, Math.round(parseFloat(x))));
        return Math.min(255, Math.max(0, Math.round(parseFloat(x) * 2.55)));
      }
      var hex = ((1 << 24) + (ch(m[1]) << 16) + (ch(m[2]) << 8) + ch(m[3])).toString(16).slice(1);
      if (m[4] !== undefined) {
        var a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        if (a < 1) hex += ((1 << 8) + Math.round(a * 255)).toString(16).slice(1);
      }
      return '#' + hex;
    }
    // token → monaco 可用的 #hex（非法/缺失时返回 undefined，monaco 用基础主题默认值）
    function themeColor(name) {
      var v = cssVar(name);
      if (!v) return undefined;
      if (v.charAt(0) === '#') return v;
      return rgbToHex(v);
    }

    // ── ④ 编辑器配色主题：买的 VS Code 官方默认（Dark/Light Modern）──────
    // 界面皮肤仍走 --dsw-* token；代码区配色/语法高亮/编辑区内悬浮补全弹层用
    // VS Code 主题 JSON（static/themes/<mode>-modern.json，host 半在
    // /dsh-ide/themes/* 托管；已拍平 include 链、自包含；来源 microsoft/vscode
    // extensions/theme-defaults，MIT 开源，见 00devCore §7"买现成零件"）。
    // 文件缺失/解析失败 → 静默回退 dsw token 合成（不阻塞编辑器启动）。
    var THEME_VER = 3; // 主题文件内容变更时 +1（打破 http 缓存）
    var THEME_FILES = { dark: 'dark-modern.json', light: 'light-modern.json' };
    var THEME_CACHE = { dark: null, light: null };
    var themeLoadPromise = null;
    function loadThemeFiles() {
      if (themeLoadPromise) return themeLoadPromise;
      themeLoadPromise = Promise.all(['dark', 'light'].map(function (mode) {
        return fetch('/dsh-ide/themes/' + THEME_FILES[mode] + '?v=' + THEME_VER).then(function (r) {
          if (!r.ok) throw new Error('http ' + r.status);
          return r.json();
        }).then(function (j) {
          if (j && typeof j === 'object' && j.colors) { THEME_CACHE[mode] = j; return; }
          throw new Error('bad theme json');
        }).catch(function (e) {
          console.error('[dsh-ide][theme] load ' + mode + ' failed:', (e && e.message) || e);
          trace('client', 'error', 'theme-load-failed', { mode: mode, error: String((e && e.message) || e) });
        });
      }));
      return themeLoadPromise;
    }
    // monaco 编辑器主题只认这些 id 家族；其余 workbench 色（sideBar.* 等）喂了也不消费
    function isEditorThemeColor(key) {
      if (key === 'focusBorder') return true;
      var fams = ['editorWidget', 'editorSuggestWidget', 'editorHoverWidget', 'editorLineNumber',
        'editorIndentGuide', 'editorWhitespace', 'editorGutter', 'editorCursor', 'editorBracketMatch',
        'editorBracketPairGuide', 'editorError', 'editorWarning', 'editorInfo', 'editorHint',
        'editorGhostText', 'editorInlayHint', 'editorStickyScroll', 'editorUnicodeHighlight', 'editor',
        'minimap', 'scrollbarSlider', 'input', 'quickInput', 'widget'];
      for (var fi = 0; fi < fams.length; fi++) {
        if (key === fams[fi] || key.indexOf(fams[fi] + '.') === 0) return true;
      }
      return false;
    }
    // 只收 #hex（VS Code 主题 JSON 全是 #hex；monaco 也只吃 #hex，见踩坑 16）
    var THEME_HEX = /^#[0-9a-fA-F]{3,4}$|^#[0-9a-fA-F]{6,8}$/;
    function hexOk(v) { return typeof v === 'string' && THEME_HEX.test(v); }
    function sanitizeTokenRules(tokenColors) {
      // VS Code tokenColors → monaco rules：scope 数组/逗号表展开为独立规则，
      // 只收合法 #hex 与 bold/italic/underline/strikethrough 样式，非法值丢弃
      // （防 defineTheme 抛 Illegal value for token color）。
      var out = [];
      for (var i = 0; i < tokenColors.length; i++) {
        var tc = tokenColors[i];
        if (!tc || typeof tc !== 'object') continue;
        var st = tc.settings || {};
        var fg = hexOk(st.foreground) ? st.foreground : null;
        var bg = hexOk(st.background) ? st.background : null;
        var fs = typeof st.fontStyle === 'string' ? st.fontStyle.trim() : '';
        if (fs && !/^(bold|italic|underline|strikethrough)(\s+(bold|italic|underline|strikethrough))*$/.test(fs)) fs = '';
        if (!fg && !bg && !fs) continue;
        var scopes = [];
        if (typeof tc.scope === 'string') scopes = tc.scope.split(',');
        else if (Array.isArray(tc.scope)) scopes = tc.scope.slice();
        for (var j = 0; j < scopes.length; j++) {
          var tok = String(scopes[j] || '').trim();
          if (!tok) continue;
          var rule = { token: tok };
          if (fg) rule.foreground = fg;
          if (bg) rule.background = bg;
          if (fs) rule.fontStyle = fs;
          out.push(rule);
        }
      }
      return out;
    }
    // dsw token 兜底色表：主题 JSON 缺项时兜底（编辑区内表面跟界面皮肤协调）
    function tokenEditorColors() {
      return {
        'editor.background': themeColor('--dsw-alias-bg-base'),
        'editor.foreground': themeColor('--dsw-alias-label-primary'),
        'editorLineNumber.foreground': themeColor('--dsw-alias-label-tertiary'),
        'editorLineNumber.activeForeground': themeColor('--dsw-alias-label-secondary'),
        'editorCursor.foreground': themeColor('--dsw-static-deepseek-400'),
        'editor.selectionBackground': themeColor('--dsw-alias-interactive-bg-active'),
        'editor.inactiveSelectionBackground': themeColor('--dsw-alias-interactive-bg-active'),
        'editor.lineHighlightBackground': themeColor('--dsw-alias-interactive-bg-hover'),
        'editorIndentGuide.background1': themeColor('--dsw-alias-border-l2'),
        'editorIndentGuide.activeBackground1': themeColor('--dsw-alias-border-l3'),
        'editorWhitespace.foreground': themeColor('--dsw-alias-border-l2'),
        'editorGutter.background': themeColor('--dsw-alias-bg-base'),
        'editorWidget.background': themeColor('--dsw-alias-bg-layer-2'),
        'editorWidget.border': themeColor('--dsw-alias-border-l2'),
        'editorSuggestWidget.background': themeColor('--dsw-alias-bg-layer-2'),
        'editorSuggestWidget.border': themeColor('--dsw-alias-border-l2'),
        'editorSuggestWidget.selectedBackground': themeColor('--dsw-alias-interactive-bg-active'),
        'editorHoverWidget.background': themeColor('--dsw-alias-bg-layer-2'),
        'editorHoverWidget.border': themeColor('--dsw-alias-border-l2'),
        'input.background': themeColor('--dsw-specific-input-major'),
        'input.foreground': themeColor('--dsw-alias-label-primary'),
        'input.border': themeColor('--dsw-alias-border-l2'),
        'focusBorder': themeColor('--dsw-alias-state-business-primary'),
        'minimap.background': themeColor('--dsw-alias-bg-base'),
        'scrollbarSlider.background': themeColor('--dsw-alias-border-l3'),
        'scrollbarSlider.hoverBackground': themeColor('--dsw-alias-border-l4'),
        'editorBracketMatch.background': themeColor('--dsw-alias-interactive-bg-active'),
        'editorError.foreground': themeColor('--dsw-alias-state-error-primary'),
        'editorWarning.foreground': themeColor('--dsw-alias-state-warn-primary'),
      };
    }
    // 合成 monaco 主题：dsw 兜底 ← 主题 JSON 覆盖（只取编辑器 id 家族 + 合法 hex）。
    // 每次生成唯一主题名，避免 defineTheme 重名抛错。数据在创建/切换时实时读：
    // 切换后 body 上的 CSS 变量已更新（--dsw 兜底色随明暗走）。
    var MONACO_THEME_SEQ = 0;
    function monacoThemeName(monaco, mode) {
      MONACO_THEME_SEQ += 1;
      var name = 'dside-' + mode + '-' + MONACO_THEME_SEQ;
      var colors = tokenEditorColors();
      var rules = [];
      var th = THEME_CACHE[mode];
      if (th) {
        if (th.colors) {
          for (var k in th.colors) {
            if (!Object.prototype.hasOwnProperty.call(th.colors, k)) continue;
            if (!isEditorThemeColor(k) || !hexOk(th.colors[k])) continue;
            colors[k] = th.colors[k];
          }
        }
        // minimap 在代码区内：主题没给独立色时跟随编辑器背景
        if (colors['editor.background']) colors['minimap.background'] = colors['editor.background'];
        if (Array.isArray(th.tokenColors)) rules = sanitizeTokenRules(th.tokenColors);
      }
      monaco.editor.defineTheme(name, {
        base: mode === 'dark' ? 'vs-dark' : 'vs',
        inherit: true,
        rules: rules,
        colors: colors,
      });
      return name;
    }

    // 扩展名 → monaco language id（按 monaco 自带语言注册表动态推导）
    var LANG_EXT_CACHE = null;
    function languageFor(monaco, fileName) {
      var dot = fileName.lastIndexOf('.');
      if (dot <= 0) return 'plaintext';
      var ext = fileName.slice(dot).toLowerCase();
      try {
        if (!LANG_EXT_CACHE) {
          LANG_EXT_CACHE = {};
          var langs = monaco.languages.getLanguages();
          for (var i = 0; i < langs.length; i++) {
            var exts = langs[i].extensions || [];
            for (var j = 0; j < exts.length; j++) {
              LANG_EXT_CACHE[exts[j].toLowerCase()] = langs[i].id;
            }
          }
        }
        return LANG_EXT_CACHE[ext] || 'plaintext';
      } catch (e) { return 'plaintext'; }
    }

    // ── 语言级编辑器默认（对齐 VSCode 的 configurationDefaults，2026-09-22 用户要求）──
    // 依据（铁律①，本地源码）：`extensions/markdown-language-features/package.json` 的
    //   configurationDefaults["[markdown]"] = { "editor.wordWrap": "on", "editor.quickSuggestions": 三条 off }
    // 也就是：**markdown 默认自动换行，其它语言（txt / 各种代码）保持 off** —— 正是用户要的效果
    //（"md 我浏览时自动换行；txt 一行几千字也显示在同一行"）。
    // ⚠ 这是 monaco 的**视觉换行**（wordWrap），不会往文件里插任何换行符，存盘内容一个字节都不变。
    var LANG_EDITOR_DEFAULTS = {
      markdown: { wordWrap: 'on' },
    };
    function langEditorOptions(lang) {
      var d = LANG_EDITOR_DEFAULTS[String(lang || '')];
      return { wordWrap: (d && d.wordWrap) ? d.wordWrap : 'off' };
    }

    // ── 媒体预览：哪些扩展名走"预览器"而不是文本编辑器（对齐 VSCode 内置 media-preview）──
    // 依据（铁律①，本地源码 `D:\04other\vscode-src\extensions\media-preview\package.json` 的
    // customEditors.selector，逐个抄下来）：
    //   imagePreview.previewEditor → *.{jpg,jpe,jpeg,png,bmp,gif,ico,webp,avif,svg}
    //   vscode.audioPreview        → *.{mp3,wav,ogg,oga}
    //   vscode.videoPreview        → *.{mp4,webm}
    // 行为差异（故意的）：VSCode 把预览做成 webview 自定义编辑器（一个 webview 一份状态）；
    // 我们直接渲染在中间面板同一个编辑器槽位里，缩放状态按标签路径各自记（见 MediaPreview）。
    var MEDIA_EXT = {
      image: ['png', 'jpg', 'jpe', 'jpeg', 'bmp', 'gif', 'ico', 'webp', 'avif', 'svg'],
      audio: ['mp3', 'wav', 'ogg', 'oga'],
      video: ['mp4', 'webm'],
    };
    function extOfName(name) {
      var dot = String(name || '').lastIndexOf('.');
      return dot > 0 ? String(name).slice(dot + 1).toLowerCase() : '';
    }
    function mediaKindOf(name) {
      var ext = extOfName(name);
      if (!ext) return null;
      for (var k in MEDIA_EXT) if (MEDIA_EXT[k].indexOf(ext) >= 0) return k;
      return null;
    }
    function isSvgName(name) { return extOfName(name) === 'svg'; }
    // 哪些文件能进 Markdown 文档预览（2026-10-14）：与 VSCode 那份清单同宽
    // （extensions/markdown-language-features/package.json 的 `extensions: ['md','markdown']`）。
    function isMarkdownName(name) { var e = extOfName(name); return e === 'md' || e === 'markdown'; }
    // 原始字节 URL（host /raw-file）。v= 是破缓存用的版本串（VSCode 同样给 webview 资源挂 ?version=）
    function rawFileUrl(path, rev) {
      return '/dsh-ide/raw-file?path=' + encodeURIComponent(String(path || '')) + '&v=' + encodeURIComponent(String(rev || 0));
    }
    // VSCode imagePreview.js 的缩放档位（原样抄：+/- 命令按它逐档走）
    var IMAGE_ZOOM_LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.5, 2, 3, 5, 7, 10, 15, 20];
    // VSCode zoomStatusBarEntry 的"选缩放级别"快捷项，以及超过它就上 pixelated 的阈值
    var IMAGE_QUICK_SCALES = [10, 5, 2, 1, 0.5, 0.2, 'fit'];
    var IMAGE_PIXELATION_THRESHOLD = 3;
    var IMAGE_PINCH_FACTOR = 0.075;
    function fileSizeText(n) {
      if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(2) + ' MB';
    }

    // ── 工具 ─────────────────────────────────────────────────────
    var ICONS = {
      js: 'JS', ts: 'TS', json: '{}', md: 'M↓', yml: 'YM', yaml: 'YM',
      css: '#', html: '<>', txt: 'TX', py: 'PY', toml: 'TM',
    };
    function iconFor(node) {
      if (node.type === 'directory') return '📁';
      if (node.type !== 'file') return '❔';
      var mk = mediaKindOf(node.name);
      if (mk === 'image') return '🖼';
      if (mk === 'audio') return '🎵';
      if (mk === 'video') return '🎬';
      var dot = node.name.lastIndexOf('.');
      if (dot <= 0) return '📄';
      return ICONS[node.name.slice(dot + 1).toLowerCase()] || '📄';
    }
    function formatTime(t) {
      if (typeof t !== 'number') return '';
      var d = new Date(t);
      function p(n) { return String(n).padStart(2, '0'); }
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    // ── 组件 ─────────────────────────────────────────────────────
    // ③ fuzzy 子序列匹配：返回分数（越大越靠前）或 null（不匹配）。
    // 连续匹配与行首/分隔符后命中加权（VSCode 快速打开手感）。
    function fuzzyScore(query, text) {
      if (!query) return 0;
      var q = query.toLowerCase(), t = String(text || '').toLowerCase();
      if (!t) return null;
      var ti = 0, score = 0, streak = 0, first = -1, last = -1;
      for (var qi = 0; qi < q.length; qi++) {
        var c = q[qi];
        var found = t.indexOf(c, ti);
        if (found < 0) return null;
        if (first < 0) first = found;
        if (found === last + 1) { streak += 1; score += 2 + streak * 2; } else { streak = 0; score += 1; }
        ti = found + 1;
        last = found;
      }
      if (first === 0) score += 6;
      if (first > 0 && (text.charAt(first - 1) === '/' || text.charAt(first - 1) === '\\')) score += 3;
      return score;
    }
    // 文件条目对查询打分：全路径与文件名两个通道取最高分
    function fileScore(item, query) {
      if (!query) return Math.max(1, 200000 - item._i); // 空查询：按遍历序稳定列出
      var full = fuzzyScore(query, item._rel);
      var base = fuzzyScore(query, item.name);
      if (full === null) return base; // 两者皆 null 时返回 null
      if (base === null) return full;
      return Math.max(full, base + 1); // 文件名命中略优先
    }
    // 命令条目打分：标题 + 分类 + 关键词
    function commandScore(cmd, query) {
      if (!query) return 1;
      var hay = (cmd.title || '') + ' ' + (cmd.cat || '') + ' ' + (cmd.keywords || '');
      return fuzzyScore(query, hay);
    }
    function basenameOf(p) {
      var s = String(p || '');
      var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
      return i < 0 ? s : s.slice(i + 1);
    }

    // ── @ 引用的「打开的文件」候选源（2026-10-19 用户要求）──────────────────
    // 外壳每帧把"当前打开的文件"写进 mentionFilesState，候选源读它。
    // 为什么不用 state/props 递：候选源是 apply 里注册的普通对象，拿不到组件树；
    // 这份快照是纯派生值（不触发渲染），渲染期直接写是这里最省的一条路。
    var mentionFilesState = { list: [], cwd: '' };

    /** 把标签列表镜像成候选源要的形状：当前激活的排第一，其余按标签从左到右。 */
    function syncMentionOpenFiles(tabs, activePath, cwd) {
      var list = [], active = null, i;
      if (Array.isArray(tabs)) {
        for (i = 0; i < tabs.length; i++) {
          var t = tabs[i];
          // diff:// / settings:// / browser:// 这类虚拟标签不是文件，不能进 @ 候选
          if (!t || !t.path || String(t.path).indexOf('://') >= 0) continue;
          var path = String(t.path);
          var item = { path: path, name: String(t.name || basenameOf(path)) };
          if (activePath && path === activePath) active = item;
          else list.push(item);
        }
      }
      var out = active ? [active].concat(list) : list;
      if (out.length > 12) out.length = 12;   // 只取前 3，留 12 是给"激活项变化时顺序重排"留余量
      mentionFilesState.list = out;
      mentionFilesState.cwd = String(cwd || '');
    }

    /** 绝对路径 → 相对工作目录的展示路径（分隔符统一成 /，与官方候选一致）。 */
    function mentionRelPath(path, cwd) {
      var p = String(path || '').replace(/\\/g, '/');
      var base = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
      if (!base || !p) return p;
      var lower = p.toLowerCase(), b = base.toLowerCase();
      if (lower.indexOf(b + '/') === 0) return p.slice(base.length + 1);
      return p;   // 工作区外用绝对路径（引擎的引用语法允许绝对路径）
    }

    /** 引用文本：与官方 @file 同一条格式，含空白时用 @"..."。 */
    function mentionTextFor(path, cwd) {
      var rel = mentionRelPath(path, cwd);
      if (!rel) return '';
      return /\s/.test(rel) ? '@"' + rel + '"' : '@' + rel;
    }

    /** 候选行右侧的位置说明（父目录）；根目录下的文件没有可说的位置。 */
    function mentionDescriptionFor(path, cwd) {
      var rel = mentionRelPath(path, cwd);
      var slash = rel.lastIndexOf('/');
      return slash <= 0 ? '' : rel.slice(0, slash);
    }
    function relDisplay(p, root) {
      var s = String(p || '');
      var r = String(root || '');
      if (r && (s === r || s.slice(0, r.length + 1) === r + '/' || s.slice(0, r.length + 1) === r + '\\')) {
        var rel = s.slice(r.length);
        return rel.replace(/^[\\/]+/, '');
      }
      return s;
    }
    function markSegments(text, startInLine, column, qlen) {
      var idx = column - 1 - startInLine; // 窗口内命中起点
      if (idx < 0 || idx >= text.length) return [text];
      var out = [];
      if (idx > 0) out.push(text.slice(0, idx));
      out.push(h('mark', null, text.slice(idx, idx + qlen)));
      if (idx + qlen < text.length) out.push(text.slice(idx + qlen));
      return out;
    }

    // ③ 通用命令面板/快速打开面板（VSCode QuickPick 风格）
    function PaletteOverlay(props) {
      var inputRef = React.useRef(null);
      var queryState = React.useState('');
      var query = queryState[0], setQuery = queryState[1];
      var itemsState = React.useState(null); // null=加载中 | {error} | item[]
      var items = itemsState[0], setItems = itemsState[1];
      var selState = React.useState(0);
      var sel = selState[0], setSel = selState[1];

      React.useEffect(function () {
        var alive = true;
        setItems(null);
        props.fetchItems().then(function (list) {
          if (!alive) return;
          setItems(list || []);
          setSel(0);
        }).catch(function (e) {
          if (!alive) return;
          setItems({ error: String((e && e.message) || e) });
        });
        function onEsc(e) { if (e.key === 'Escape' && props.onClose) props.onClose(); }
        window.addEventListener('keydown', onEsc, false);
        if (inputRef.current) inputRef.current.focus();
        return function () {
          alive = false;
          window.removeEventListener('keydown', onEsc, false);
        };
      }, []);

      var filtered = null;
      if (items && !items.error) {
        var q = query.trim();
        filtered = [];
        for (var i = 0; i < items.length; i++) {
          var sc = props.score(items[i], q);
          if (sc === null || sc === undefined) continue;
          filtered.push({ it: items[i], sc: sc });
          if (filtered.length >= 300) break;
        }
        filtered.sort(function (a, b) { return b.sc - a.sc; });
      }
      var cur = Math.max(0, Math.min(sel, (filtered ? filtered.length : 0) - 1));

      function onKeyDown(e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (filtered && filtered.length) setSel(cur + 1 >= filtered.length ? 0 : cur + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (filtered && filtered.length) setSel(cur - 1 < 0 ? filtered.length - 1 : cur - 1); }
        else if (e.key === 'Enter') { e.preventDefault(); if (filtered && filtered[cur]) { var pick = filtered[cur].it; if (props.onPick) props.onPick(pick); } }
      }

      var listEls = [];
      if (!items) {
        listEls.push(h('div', { key: 'l', className: 'dside-overlay-note' }, '加载中…'));
      } else if (items.error) {
        listEls.push(h('div', { key: 'e', className: 'dside-overlay-err' }, '加载失败: ' + items.error));
      } else if (filtered.length === 0) {
        listEls.push(h('div', { key: 'e', className: 'dside-overlay-note' }, '没有匹配项'));
      } else {
        for (var k = 0; k < filtered.length; k++) {
          (function (item, index) {
            var d = props.describe ? props.describe(item) : { icon: '', title: String(item), detail: '' };
            listEls.push(h('div', {
              key: index,
              className: 'dside-palette-item' + (index === cur ? ' sel' : ''),
              onMouseEnter: function () { setSel(index); },
              onClick: function () { if (props.onPick) props.onPick(item); },
            },
              h('span', { className: 'dside-palette-item-icon' }, d.icon || ''),
              h('span', { className: 'dside-palette-item-title' }, d.title),
              d.detail ? h('span', { className: 'dside-palette-item-detail' }, d.detail) : null,
            ));
          })(filtered[k].it, k);
        }
      }

      return h('div', { className: 'dside-overlay', onClick: function () { if (props.onClose) props.onClose(); } },
        h('div', { className: 'card', onClick: function (e) { e.stopPropagation(); } },
          h('div', { className: 'dside-palette-head' },
            h('span', { className: 'dside-palette-title' }, props.title || ''),
            h('input', {
              ref: inputRef, className: 'dside-palette-input', placeholder: props.placeholder || '输入以过滤…',
              value: query,
              onChange: function (e) { setQuery(e.target.value); setSel(0); },
              onKeyDown: onKeyDown,
            }),
          ),
          h('div', { className: 'dside-palette-list' }, listEls),
        ),
      );
    }

    // ⑬ 终端前端：xterm.js 经 script 标签从 host 静态托管加载（同 monaco，绕开 bundle 纯度门禁）
    var xtermPromise = null;
    var XTERM_BASE = '/dsh-ide/xterm';
    var XTERM_VER = '5.5.0';

    function loadXterm() {
      if (xtermPromise) return xtermPromise;

      // ⚠ xterm.js 是 **UMD**，头部就是 `else if (typeof define === "function" && define.amd) define([], t)`
      // —— 页面上有 monaco 的 AMD loader 时，这个**匿名 define** 会被 monaco 直接拒掉：
      // `Can only have one anonymous define call per script file`（实测踩到，xterm 根本没加载）。
      // 解法：加载期间把 window.define 换成**自己的 stub**（带 .amd 标记，UMD 才会走 define 分支），
      // 把 UMD 传进来的工厂函数抓下来**自己调用**，拿到导出对象后再还原 define。
      // 这样既不需要 eval（CSP 无关），也不需要删除 monaco 的属性（它可能是不可配置的）。
      function pickCtor(ns, name) {
        if (typeof ns === 'function') return ns;
        if (ns && typeof ns[name] === 'function') return ns[name];
        if (ns && ns.default && typeof ns.default[name] === 'function') return ns.default[name];
        if (ns && ns.default && typeof ns.default === 'function') return ns.default;
        return null;
      }
      function loadUmdAsGlobal(url) {
        return new Promise(function (resolve, reject) {
          var saved = window.define;
          var captured = null;
          var stub = function (deps, factory) {
            if (typeof deps === 'function') captured = deps;
            else if (typeof factory === 'function') captured = factory;
          };
          stub.amd = true;
          var installed = false;
          try { window.define = stub; installed = window.define === stub } catch (e) { installed = false }
          var restore = function () {
            try {
              if (saved) window.define = saved;
              else { try { delete window.define } catch (e) { /* ignore */ } }
            } catch (e) { /* ignore */ }
          };
          if (!installed) { reject(new Error('无法替换 window.define（monaco loader 占用）')); return }
          var s = document.createElement('script');
          s.src = url;
          s.onerror = function () { restore(); reject(new Error('script failed: ' + url)); };
          s.onload = function () {
            restore();
            if (!captured) { reject(new Error('UMD 未走 define 分支: ' + url)); return }
            try { resolve(captured()) } catch (e) { reject(e) }
          };
          document.head.appendChild(s);
        });
      }

      xtermPromise = new Promise(function (resolve, reject) {
        if (!document.querySelector('link[data-dsh-xterm]')) {
          var link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = XTERM_BASE + '/xterm.css?v=' + XTERM_VER;
          link.setAttribute('data-dsh-xterm', '1');
          document.head.appendChild(link);
        }
        var out = { Terminal: null, FitAddon: null };
        loadUmdAsGlobal(XTERM_BASE + '/xterm.js?v=' + XTERM_VER)
          .then(function (ns) {
            out.Terminal = pickCtor(ns, 'Terminal');
            return loadUmdAsGlobal(XTERM_BASE + '/addon-fit.js?v=' + XTERM_VER);
          })
          .then(function (ns) {
            out.FitAddon = pickCtor(ns, 'FitAddon');
            if (typeof out.Terminal !== 'function') throw new Error('xterm Terminal 构造函数未拿到');
            trace('ui', 'info', 'xterm-loaded', { fit: typeof out.FitAddon === 'function' });
            resolve(out);
          })
          .catch(function (e) {
            xtermPromise = null;
            console.error('[dsh-ide][xterm] load failed', e);
            trace('client', 'error', 'xterm-load-failed', { stage: String((e && e.message) || e) });
            reject(e);
          });
      });
      return xtermPromise;
    }

    // 终端配色也吃 --dsw-* token（xterm 要具体色值，所以过 themeColor 转 #hex）
    function termTheme() {
      var cs = getComputedStyle(document.body);
      var pick = function (name, fallback) {
        var v = cs.getPropertyValue(name);
        var c = v ? themeColor(v) : null;
        return c || fallback;
      };
      return {
        background: pick('--dsw-alias-bg-base', '#1f1f1f'),
        foreground: pick('--dsw-alias-label-primary', '#cccccc'),
        cursor: pick('--dsw-alias-label-primary', '#cccccc'),
        selectionBackground: pick('--dsw-alias-state-business-primary', '#26497d'),
      };
    }

    // ⑬ 集成终端面板：host 起**真 PTY**（node-pty），这里用 xterm.js 渲染。
    // 输出 100ms 轮询 /term-read（与 /stat、/fs-rev 同一套路，简单可测）；输入 POST /term-input；
    // 尺寸变化（面板开关/窗口缩放）经 ResizeObserver → fit → POST /term-resize。
    // ═══ 「Agent幻影」键盘映射面板（第三期，2026-10-08）══════════════════════════════
    // 位置：中下方那块面板里、与终端**并列的一个标签**（设计定稿 §4.4）。
    // 它只回答一件事：Agent 此刻在敲什么键 —— 键帽真的亮、修饰键显示"正被按住"、右边滚最近按键流。
    // 数据源只有一条：**我们自己动作层的记账**（driver.js 记 → 壳 → 这里）。
    //   ⇒ 用 browser_run_code 兜底跑出来的按键**不会亮**：那是黑盒，幻影只演我们自己发起的动作。
    // ⚠ 不自动抢：Agent 开始打字时**不切过来**，只在标签上闪个小点（见 TermPanel 的 kbFlash）。
    var KB_ROWS = [
      ['Esc', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='],
      ['Tab', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']'],
      ['Caps', 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'", 'Enter'],
      ['Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/', 'Backspace'],
    ];
    var KB_BOTTOM = ['Ctrl', 'Alt', 'Meta', 'Space'];
    var KB_ARROWS = ['←', '↑', '↓', '→'];
    var KB_IS_MOD = { Ctrl: 1, Alt: 1, Meta: 1, Shift: 1 };
    // Playwright 的键名 → 键帽标识。**两边必须对得上**，否则会出现"Agent 明明按了、面板却不亮"。
    function kbNorm(name) {
      var n = String(name || '');
      if (n === '') return '';
      if (n === ' ' || n === 'Space' || n === 'Spacebar') return 'Space';
      if (n === 'Control' || n === 'Ctrl') return 'Ctrl';
      if (n === 'Meta' || n === 'Command' || n === 'Cmd' || n === 'Super') return 'Meta';
      if (n === 'Alt' || n === 'AltGraph') return 'Alt';
      if (n === 'Shift') return 'Shift';
      if (n === 'Escape' || n === 'Esc') return 'Esc';
      if (n === 'Enter' || n === 'NumpadEnter') return 'Enter';
      if (n === 'Tab') return 'Tab';
      if (n === 'Backspace') return 'Backspace';
      if (n === 'CapsLock') return 'Caps';
      if (n === 'ArrowLeft') return '←';
      if (n === 'ArrowRight') return '→';
      if (n === 'ArrowUp') return '↑';
      if (n === 'ArrowDown') return '↓';
      if (n === 'Delete') return 'Del';
      if (n === 'PageUp') return 'PgUp';
      if (n === 'PageDown') return 'PgDn';
      if (n.length === 1) return n.toUpperCase();
      return n;
    }

    function KeyboardPanel(props) {
      var kb = props.kb || {};
      var held = kb.held || {};
      var recent = kb.recent || [];
      var streamRef = React.useRef(null);
      function cap(k) {
        return h('kbd', {
          key: k,
          className: 'dside-kbd kb' + (held[k] ? ' on' : '') + (k.length > 2 ? ' wide' : ''),
        }, k);
      }
      var rows = [];
      for (var ri = 0; ri < KB_ROWS.length; ri++) {
        rows.push(h('div', { className: 'dside-kbrow', key: 'r' + ri }, KB_ROWS[ri].map(cap)));
      }
      rows.push(h('div', { className: 'dside-kbrow', key: 'rm' }, KB_BOTTOM.map(cap)));
      rows.push(h('div', { className: 'dside-kbrow kb-arrows', key: 'ra' }, KB_ARROWS.map(cap)));
      // 时间顺序**旧 → 新**（2026-10-14 用户拍板翻过来）：recent 末尾才是最新那个键，
      // 也就是"现在"。别改回倒序 —— 读的人要顺着念出 Agent 的输入过程，倒着念是反的。
      var stream = [];
      for (var i = Math.max(0, recent.length - 40); i < recent.length; i++) {
        stream.push(h('span', { className: 'dside-kbchip' + (i === recent.length - 1 ? ' now' : ''), key: 'c' + i }, recent[i]));
      }
      // 最新那个在流末尾 ⇒ 不把滚动跟到底它就会滑出可视区，面板看着像"卡住不动"
      React.useEffect(function () {
        var el = streamRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
      return h('div', { className: 'dside-kbpanel' },
        h('div', { className: 'dside-kbpanel-left' }, rows),
        h('div', { className: 'dside-kbpanel-right' },
          h('div', { className: 'dside-kbpanel-title' }, '最近按键（旧 → 新）'),
          recent.length === 0
            ? h('div', { className: 'dside-kbpanel-hint' }, 'Agent 在内置浏览器里打字/按键时，这里会实时亮起来。'
                + '它走兜底代码（browser_run_code）敲的键不在这里显示 —— 幻影只演我们自己发起的动作。')
            : h('div', { className: 'dside-kbstream', ref: streamRef }, stream),
        ),
      );
    }

    function TermPanel(props) {
      // 面板内的标签：'term' 终端 / 'keys' Agent键盘映射（第三期）。状态在 IdeApp 那层，
      // 因为"Agent 打字时该不该闪点"要由它判断。
      var pane = props.pane === 'keys' ? 'keys' : 'term';
      var hostRef = React.useRef(null);
      var termRef = React.useRef(null);
      var fitRef = React.useRef(null);
      var idRef = React.useRef(null);
      var seqRef = React.useRef(0);
      var timerRef = React.useRef(null);
      var phaseState = React.useState('starting'); // starting | ready | exited | error
      var phase = phaseState[0], setPhase = phaseState[1];
      var errState = React.useState(null);
      var err = errState[0], setErr = errState[1];
      var sizeState = React.useState('');           // 终端尺寸（cols×rows），显示在标题栏，见 applyFit
      var size = sizeState[0], setSize = sizeState[1];

      React.useEffect(function () {
        var disposed = false;

        // 统一"重新适配尺寸"：挂载后、会话起好后、容器尺寸变化时都走它。
        // ⚠ 实测（2026-09-21 用户报障"终端呼不出来"）PTY 曾被以 **20 列 × 14 行** 建起来
        // —— 面板刚挂载那一瞬布局还没定型（容器只有 ~170px 宽），fit 算出极小 cols/rows，
        // shell 于是在窄宽度里疯狂换行，看着就像"终端坏了"。所以起完会话要再补几次 fit。
        function applyFit() {
          if (disposed) return;
          try { if (fitRef.current) fitRef.current.fit() } catch (e) { return }
          var t = termRef.current;
          if (t && idRef.current) {
            apiPost('/term-resize', { id: idRef.current, cols: t.cols, rows: t.rows });
            // 把尺寸显示在终端标题栏（用户 2026-09-21 第三次报"按 Ctrl+` 呼不出终端"之后加的）：
            // 被布局挤成窄条时，标题栏会直接写着 `20×14` —— 一眼区分"没打开"和"打开了但太窄"，
            // 免得再靠日志猜（§6 73 的教训：面板类功能要把自己的尺寸露出来）。
            setSize(t.cols + '×' + t.rows);
          }
        }

        function pollTerm() {
          var id = idRef.current;
          if (!id || disposed) return;
          apiGet('/term-read', { id: id, since: seqRef.current }).then(function (r) {
            if (disposed || !r || r.error) return;
            if (r.reset) { try { termRef.current.clear() } catch (e) { /* ignore */ } }
            if (r.data) { try { termRef.current.write(r.data) } catch (e) { /* ignore */ } }
            if (typeof r.seq === 'number') seqRef.current = r.seq;
            if (r.exited) {
              setPhase('exited');
              if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
            }
          });
        }

        loadXterm().then(function (ns) {
          if (disposed || !hostRef.current) return;
          var Terminal = ns && ns.Terminal;
          if (typeof Terminal !== 'function') { setErr('xterm Terminal 不可用'); setPhase('error'); return; }
          var term = new Terminal({
            fontFamily: 'var(--ds-font-family-code), Consolas, "Courier New", monospace',
            fontSize: 12.5,
            cursorBlink: true,
            scrollback: 3000,
            theme: termTheme(),
          });
          var FitCtor = ns && ns.FitAddon;
          var fit = typeof FitCtor === 'function' ? new FitCtor() : null;
          if (fit && term.loadAddon) term.loadAddon(fit);
          term.open(hostRef.current);
          termRef.current = term;
          fitRef.current = fit;
          try { if (fit) fit.fit() } catch (e) { /* 布局尚未完成 */ }
          apiPost('/term-create', { cols: term.cols || 100, rows: term.rows || 30, cwd: props.root }).then(function (r) {
            if (disposed) return;
            if (!r || r.error) { setErr((r && (r.detail || r.error)) || 'network'); setPhase('error'); return; }
            idRef.current = r.id;
            setPhase('ready');
            term.onData(function (d) { apiPost('/term-input', { id: r.id, data: d }); });
            timerRef.current = setInterval(pollTerm, 100);
            pollTerm();
            term.focus();
            trace('ui', 'info', 'term-open', { id: r.id, cwd: r.cwd || null });
            // 会话起好后再补三次适配（下一帧 / 120ms / 400ms）：布局定型后把真实尺寸报给 PTY
            if (window.requestAnimationFrame) window.requestAnimationFrame(applyFit);
            setTimeout(applyFit, 120);
            setTimeout(applyFit, 400);
          }).catch(function (e) { setErr(String((e && e.message) || e)); setPhase('error'); });
        }).catch(function (e) { setErr(String((e && e.message) || e)); setPhase('error'); });

        var ro = null;
        if (window.ResizeObserver && hostRef.current) {
          ro = new ResizeObserver(function () { applyFit(); });
          ro.observe(hostRef.current);
        }

        return function () {
          disposed = true;
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
          if (ro) ro.disconnect();
          if (idRef.current) apiPost('/term-close', { id: idRef.current });
          var dead = termRef.current;
          termRef.current = null;
          // 也要清掉 fit 引用：否则排队中的 rAF/超时回调会对**已 dispose 的终端**再 fit 一次，
          // xterm 内部会在 Viewport.syncScrollArea 里抛 "reading 'dimensions'"（异步抛，抓不住）
          fitRef.current = null;
          // dispose 推迟一帧：xterm 自己排的刷新回调先跑完再销毁，否则同样会踩上面那个异步异常
          if (dead) setTimeout(function () { try { dead.dispose() } catch (e) { /* ignore */ } }, 0);
        };
      }, []);

      return h('div', { className: 'dside-term', style: props.height ? { height: Math.round(props.height) + 'px' } : null },
        // ⑰ 高度手柄：压在面板上边缘（VSCode 的 sash 也不占布局空间）
        props.onResize
          ? h(Sash, {
              dir: 'row', edge: 'top',
              onDrag: function (d) { props.onResize(d); },
              onReset: props.onResizeReset,
            })
          : null,
        h('div', { className: 'dside-term-head' },
          // 面板内的标签栏（第三期）：终端 / Agent键盘映射。这是**面板内**的标签，
          // 与中间列的编辑器标签是两回事，别混。
          h('span', { className: 'dside-term-tabs' },
            h('button', {
              className: 'dside-term-tab' + (pane === 'term' ? ' on' : ''),
              onClick: function () { if (props.onPane) props.onPane('term'); },
            }, '🖥 终端'),
            h('button', {
              className: 'dside-term-tab' + (pane === 'keys' ? ' on' : ''),
              title: 'Agent 键盘映射：Agent 在内置浏览器里打字时，这里实时亮键',
              onClick: function () { if (props.onPane) props.onPane('keys'); },
            },
              '⌨ 键盘',
              (props.kbFlash && pane !== 'keys') ? h('span', { className: 'dside-dot dirty' }) : null),
          ),
          pane === 'term'
            ? h('span', { className: 'st' },
                phase === 'error' ? ('启动失败：' + String(err))
                  : phase === 'exited' ? '进程已退出'
                    : phase === 'starting' ? '启动中…' : (size || ''))
            : h('span', { className: 'st' }, 'Agent 操作内置浏览器时，实时显示它按下的键'),
          // 这里只剩「关闭终端」，对齐 VSCode 面板标题栏的 Hide Panel（`panelActions.ts:74-81`）。
          // ⚠ 别再往这儿加"重新适配尺寸"这类按钮：fit / `/term-resize` 在尺寸变化时由 ResizeObserver 自动跑，
          //   手动再放一颗既冗余、点了又看不出效果（2026-09-30 用户报"无效"→ 去掉）。VSCode 那颗 `order:1`
          //   是**最大化面板**（`toggleMaximizedPanel`），天工没有"面板最大化"这个能力，不要用别的动作冒充它。
          h('button', {
            className: 'dside-btn', title: '关闭终端',
            onClick: function () { if (props.onClose) props.onClose(); },
          }, '✕'),
        ),
        // ⚠ 终端宿主**只隐藏、不卸载**：xterm 的容器一旦离开文档，回来会是一片空白（要等重新 fit）。
        //   切回终端时尺寸变化会触发面板自己的 ResizeObserver → 自动重新 fit。
        h('div', { className: 'dside-term-body', ref: hostRef, style: pane === 'keys' ? { display: 'none' } : null }),
        pane === 'keys' ? h(KeyboardPanel, { kb: props.kb }) : null,
      );
    }

    // ⑫ 文件树右键菜单（位置随鼠标，Esc / 点空白关闭）
    // ⑰ 面板拖拽手柄（对齐 VSCode 的 sash）：4px 命中区、平时不可见、hover 出现 1px 高亮线、
    // 双击恢复默认尺寸（VSCode 的 workbench.sash.size 默认就是 4，hoverDelay 300ms）。
    // 拖拽期间给 body 挂类：全局禁选文本 + 统一光标（否则拖到编辑器上会选中文字）。
    function Sash(props) {
      var dragRef = React.useRef(null);
      var activeState = React.useState(false);
      var active = activeState[0], setActive = activeState[1];
      function onDown(e) {
        e.preventDefault();
        dragRef.current = { x: e.clientX, y: e.clientY };
        setActive(true);
        document.body.classList.add(props.dir === 'col' ? 'dside-resizing-col' : 'dside-resizing-row');
        function move(ev) {
          var s = dragRef.current;
          if (!s) return;
          var d = props.dir === 'col' ? (ev.clientX - s.x) : (ev.clientY - s.y);
          s.x = ev.clientX; s.y = ev.clientY;   // 增量式：每次事件报一次位移
          if (d && props.onDrag) props.onDrag(d);
        }
        function up() {
          dragRef.current = null;
          setActive(false);
          document.body.classList.remove('dside-resizing-col', 'dside-resizing-row');
          window.removeEventListener('mousemove', move, true);
          window.removeEventListener('mouseup', up, true);
        }
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
      }
      return h('div', {
        className: 'dside-sash ' + props.dir + (props.edge ? ' ' + props.edge : '') + (active ? ' active' : ''),
        'data-sash': props.dir,
        title: (props.dir === 'col' ? '拖拽调整宽度' : '拖拽调整高度') + '（双击恢复默认）',
        onMouseDown: onDown,
        onDoubleClick: function () { if (props.onReset) props.onReset(); },
      });
    }

    function TreeMenu(props) {
      var items = props.items || [];
      React.useEffect(function () {
        function onKey(e) { if (e.key === 'Escape' && props.onClose) props.onClose(); }
        window.addEventListener('keydown', onKey, true);
        return function () { window.removeEventListener('keydown', onKey, true); };
      }, []);
      var els = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.sep) { els.push(h('div', { key: 's' + i, className: 'dside-menu-sep' })); continue; }
        els.push(h('div', {
          key: 'i' + i,
          className: 'dside-menu-item' + (it.disabled ? ' disabled' : ''),
          title: it.title || null,
          onClick: (function (run, dis) {
            return function () {
              if (dis) return;                       // VSCode 的 precondition：出现但置灰，点了不做事
              if (props.onClose) props.onClose();
              run();
            };
          })(it.run, it.disabled),
        }, it.label, it.keys ? h('span', { className: 'dside-menu-keys' }, it.keys) : null));
      }
      var x = Math.max(8, Math.min(props.x, window.innerWidth - 196));
      var y = Math.max(8, Math.min(props.y, window.innerHeight - (items.length * 30 + 24)));
      return h('div', {
        className: 'dside-menu',
        style: { left: x + 'px', top: y + 'px' },
        onContextMenu: function (e) { e.preventDefault(); },
      }, els);
    }

    // ⑫ 命名对话框（新建 / 重命名共用一个输入框，Enter 提交，Esc 取消）
    function NameDialog(props) {
      var valState = React.useState(props.initial || '');
      var val = valState[0], setVal = valState[1];
      var ref = React.useRef(null);
      React.useEffect(function () {
        if (ref.current) { ref.current.focus(); ref.current.select(); }
        function onKey(e) { if (e.key === 'Escape' && props.onCancel) props.onCancel(); }
        window.addEventListener('keydown', onKey, false);
        return function () { window.removeEventListener('keydown', onKey, false); };
      }, []);
      function submit() {
        var v = String(val || '').trim();
        if (!v) return;
        if (props.onSubmit) props.onSubmit(v);
      }
      return h('div', { className: 'dside-overlay', onClick: props.onCancel },
        h('div', { className: 'card dside-dialog', onClick: function (e) { e.stopPropagation(); } },
          h('div', { className: 'dside-palette-head' },
            h('span', { className: 'dside-palette-title' }, props.title || ''),
          ),
          h('div', { className: 'dside-dialog-body' },
            h('input', {
              ref: ref, value: val, placeholder: props.placeholder || '名称',
              onChange: function (e) { setVal(e.target.value); },
              onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } },
            }),
            props.hint ? h('div', { className: 'dside-palette-hint', style: { marginTop: 8 } }, props.hint) : null,
            h('div', { className: 'dside-dialog-row' },
              h('button', { className: 'dside-btn', onClick: props.onCancel }, '取消'),
              h('button', { className: 'dside-btn primary', onClick: submit }, '确定'),
            ),
          ),
        ),
      );
    }

    // ⑤ 问题面板（Ctrl+Shift+M）：聚合 monaco 的 markers（当前覆盖**已打开文件**；
    // 项目级全量诊断要等把项目文件喂给 worker 之后再逐个查 worker），按文件分组、点条目跳转。
    // 打开期间 1.5s 自刷（诊断是 worker 异步算出来的，刚打开文件时还没到）。
    function ProblemsOverlay(props) {
      var listState = React.useState([]);
      var list = listState[0], setList = listState[1];
      // ⑤ 项目级全量诊断：monaco 只为**已打开模型**给 markers，未打开的文件要自己逐个问 worker
      // （Editor 暴露的 scanProjectProblems）。每次打开面板自动扫一次，再扫点 ⟳。
      var projState = React.useState([]);
      var proj = projState[0], setProj = projState[1];
      var scanState = React.useState({ loading: false, files: 0, done: false });
      var scan = scanState[0], setScan = scanState[1];
      var scanRef = React.useRef(false);

      function runScan() {
        if (!props.onScan) return;
        setScan({ loading: true, files: 0, done: false });
        Promise.resolve(props.onScan()).then(function (res) {
          setProj((res && res.rows) || []);
          setScan({ loading: false, files: (res && res.files) || 0, done: true });
        }).catch(function () {
          setScan({ loading: false, files: 0, done: true });
        });
      }

      React.useEffect(function () {
        if (!props.onScan || scanRef.current) return;
        scanRef.current = true;
        runScan();
      }, []);

      React.useEffect(function () {
        function collect() {
          var monaco = window.monaco;
          if (!monaco || !monaco.editor) return [];
          var all = monaco.editor.getModelMarkers({}) || [];
          var out = [];
          for (var i = 0; i < all.length; i++) {
            var m = all[i];
            if (m.severity !== 8 && m.severity !== 4) continue; // 8=Error 4=Warning（info/hint 不列）
            out.push({
              path: localPathFromUri(m.resource && m.resource.path ? m.resource.path : ''),
              line: m.startLineNumber | 0,
              col: m.startColumn | 0,
              sev: m.severity === 8 ? 'error' : 'warn',
              msg: String(m.message || '').split('\n')[0].slice(0, 200),
            });
          }
          out.sort(function (a, b) { return a.path === b.path ? (a.line - b.line) : (a.path < b.path ? -1 : 1); });
          return out;
        }
        setList(collect());
        var timer = setInterval(function () { setList(collect()); }, 1500);
        function onEsc(e) { if (e.key === 'Escape' && props.onClose) props.onClose(); }
        window.addEventListener('keydown', onEsc, false);
        return function () { clearInterval(timer); window.removeEventListener('keydown', onEsc, false); };
      }, []);

      // 合并两个来源：① 已打开文件的实时 markers ② 项目级扫描结果；按 文件+位置+文案 去重
      var merged = [], seenKey = {};
      var pushIt = function (src) {
        for (var n = 0; n < src.length; n++) {
          var it = src[n];
          var key = it.path + '|' + it.line + '|' + it.col + '|' + it.msg;
          if (seenKey[key]) continue;
          seenKey[key] = 1;
          merged.push(it);
        }
      };
      pushIt(list);
      pushIt(proj);
      merged.sort(function (a, b) { return a.path === b.path ? (a.line - b.line) : (a.path < b.path ? -1 : 1); });

      var errs = 0, warns = 0, rows = [], lastPath = null;
      for (var i = 0; i < merged.length; i++) {
        var it = merged[i];
        if (it.sev === 'error') errs += 1; else warns += 1;
        if (it.path !== lastPath) {
          lastPath = it.path;
          rows.push(h('div', { key: 'f' + i, className: 'dside-problem-file' }, relDisplay(it.path, props.root)));
        }
        rows.push(h('div', {
          key: 'r' + i,
          className: 'dside-problem ' + it.sev,
          title: it.msg,
          onClick: (function (p, l, c) {
            return function () { if (props.onJump) props.onJump(p, l, c); };
          })(it.path, it.line, it.col),
        },
          h('span', { className: 'dside-problem-sev' }, it.sev === 'error' ? '✕' : '⚠'),
          h('span', { className: 'dside-problem-pos' }, it.line + ':' + it.col),
          h('span', { className: 'dside-problem-msg' }, it.msg),
        ));
      }

      return h('div', { className: 'dside-overlay', onClick: function () { if (props.onClose) props.onClose(); } },
        h('div', { className: 'card', onClick: function (e) { e.stopPropagation(); } },
          h('div', { className: 'dside-palette-head' },
            h('span', { className: 'dside-palette-title' }, '问题（' + errs + ' 个错误 · ' + warns + ' 个警告）'),
            h('span', { className: 'dside-palette-hint' },
              (scan.loading ? '正在扫描整个项目…' : (scan.done ? '全项目已扫 ' + scan.files + ' 个文件 · ' : ''))
              + 'Esc 关闭 · 点条目跳转'),
            h('button', { className: 'dside-btn', onClick: runScan, disabled: scan.loading }, '⟳ 重扫'),
          ),
          h('div', { className: 'dside-problems-list' },
            rows.length ? rows : h('div', { className: 'dside-node-loading' }, '没有错误或警告'),
          ),
        ),
      );
    }

    // ③ 全局搜索面板（Ctrl+Shift+F）：防抖 300ms → /search → 分组展示
    function SearchOverlay(props) {
      var inputRef = React.useRef(null);
      var queryState = React.useState('');
      var query = queryState[0], setQuery = queryState[1];
      var resState = React.useState(null);   // null | {loading} | {error} | {hits,searched,truncated,q,versions}
      var res = resState[0], setRes = resState[1];
      // ⑫ A3 搜索开关（VSCode 同款）+ A2 替换框
      var optState = React.useState({ case: false, regex: false, word: false });
      var opt = optState[0], setOpt = optState[1];
      var repOpenState = React.useState(false);
      var repOpen = repOpenState[0], setRepOpen = repOpenState[1];
      var repTextState = React.useState('');
      var repText = repTextState[0], setRepText = repTextState[1];
      var repBusyState = React.useState(false);
      var repBusy = repBusyState[0], setRepBusy = repBusyState[1];
      var seqRef = React.useRef(0);
      var timerRef = React.useRef(null);

      function runQuery(q) {
        var seq = ++seqRef.current;
        var trim = String(q || '').trim();
        if (!trim) { setRes(null); return; }
        setRes({ loading: true });
        apiGet('/search', {
          q: trim,
          case: opt.case ? 1 : 0,
          regex: opt.regex ? 1 : 0,
          word: opt.word ? 1 : 0,
        }).then(function (r) {
          if (seq !== seqRef.current) return; // 过期请求丢弃
          if (!r || r.error) setRes({ error: (r && r.error) || 'network' });
          else setRes({ hits: r.hits || [], searched: r.searched || 0, truncated: !!r.truncated, q: trim, versions: r.versions || {} });
        });
      }

      React.useEffect(function () {
        function onEsc(e) { if (e.key === 'Escape' && props.onClose) props.onClose(); }
        window.addEventListener('keydown', onEsc, false);
        if (inputRef.current) inputRef.current.focus();
        return function () {
          window.removeEventListener('keydown', onEsc, false);
          if (timerRef.current) clearTimeout(timerRef.current);
        };
      }, []);

      React.useEffect(function () {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(function () { runQuery(query); }, 300);
        return function () { if (timerRef.current) clearTimeout(timerRef.current); };
      }, [query, opt]);   // 开关一变就重搜（VSCode 同款）

      // ⑫ A2 替换：scope.offset 有值 = 只替换那一处；scope.paths = 替换这些文件里的全部命中；
      // 都不给 = 全部替换（所有有命中的文件）。写盘带版本令牌，磁盘变过的文件会被跳过并上报。
      function doReplace(scope) {
        var q = (res && res.q) || query.trim();
        if (!q || repBusy) return;
        var body = {
          query: q, replacement: repText,
          case: !!opt.case, regex: !!opt.regex, word: !!opt.word,
          versions: (res && res.versions) || {},
        };
        if (scope && typeof scope.offset === 'number') {
          body.paths = [scope.path];
          body.offset = scope.offset;
        } else if (scope && scope.paths) {
          body.paths = scope.paths;
        } else {
          body.paths = [];
          var seen = {};
          if (res && res.hits) {
            for (var i = 0; i < res.hits.length; i++) {
              if (!seen[res.hits[i].path]) { seen[res.hits[i].path] = 1; body.paths.push(res.hits[i].path); }
            }
          }
        }
        if (!body.paths.length) return;
        setRepBusy(true);
        apiPost('/replace', body).then(function (r) {
          setRepBusy(false);
          if (!r || r.error) {
            if (props.onStatus) props.onStatus('替换失败：' + ((r && r.error) || 'network'));
            return;
          }
          var stale = 0, failed = 0;
          for (var j = 0; j < (r.results || []).length; j++) {
            var one = r.results[j];
            if (one.error === 'stale-version') stale += 1;
            else if (!one.ok) failed += 1;
          }
          if (props.onStatus) {
            props.onStatus('已替换 ' + r.replaced + ' 处' + (r.changedFiles ? '（' + r.changedFiles + ' 个文件）' : '')
              + (stale ? ' · ' + stale + ' 个文件磁盘已变，已跳过' : '') + (failed ? ' · ' + failed + ' 个失败' : ''));
          }
          trace('ui', 'info', 'replace-done', {
            replaced: r.replaced, files: r.changedFiles, stale: stale, failed: failed,
            single: typeof scope.offset === 'number',
          });
          runQuery(q); // 重新搜一遍（行号/命中都会变）
        }).catch(function (e) {
          setRepBusy(false);
          if (props.onStatus) props.onStatus('替换失败：' + String((e && e.message) || e));
        });
      }

      function onKeyDown(e) {
        if (e.key === 'Enter') {
          if (timerRef.current) clearTimeout(timerRef.current);
          runQuery(query);
        }
      }

      // 按文件分组（命中 ≤200，直接全量渲染）
      var groups = null;
      if (res && res.hits) {
        var map = {};
        for (var i = 0; i < res.hits.length; i++) {
          var hit = res.hits[i];
          if (!map[hit.path]) map[hit.path] = { path: hit.path, name: hit.name || basenameOf(hit.path), lines: [] };
          map[hit.path].lines.push(hit);
        }
        groups = [];
        for (var p in map) groups.push(map[p]);
      }
      var qlen = Math.max(1, (query.trim() || '').length);

      var bodyEls = null;
      if (!res) {
        bodyEls = h('div', { className: 'dside-overlay-note' },
          props.root ? '输入关键词，搜索工作空间中的全部文件（Ctrl+Enter 立即搜索）' : '尚未打开工作空间：请先打开文件夹');
      } else if (res.loading) {
        bodyEls = h('div', { className: 'dside-overlay-note' }, '搜索中…');
      } else if (res.error) {
        bodyEls = h('div', { className: 'dside-overlay-err' }, '搜索失败: ' + res.error);
      } else if (groups.length === 0) {
        bodyEls = h('div', { className: 'dside-overlay-note' }, '未找到匹配内容');
      } else {
        var all = [];
        for (var g = 0; g < groups.length; g++) {
          var grp = groups[g];
          var lineEls = [];
          for (var k = 0; k < grp.lines.length; k++) {
            var hh = grp.lines[k];
            (function (hit) {
              lineEls.push(h('div', {
                key: hit.line,
                className: 'dside-search-line',
                title: hit.path + ':' + hit.line,
                onClick: function () {
                  if (props.onJump) props.onJump({ name: basenameOf(hit.path), path: hit.path }, hit.line, hit.column);
                },
              },
                h('span', { className: 'ln' }, String(hit.line)),
                markSegments(hit.text, hit.start, hit.column, qlen),
                repOpen
                  ? h('span', {
                      className: 'dside-search-rep',
                      title: '只替换这一处',
                      onClick: function (ev) { ev.stopPropagation(); doReplace({ path: hit.path, offset: hit.offset }); },
                    }, '⇄')
                  : null,
              ));
            })(grp.lines[k]);
          }
          all.push(h('div', { key: grp.path, className: 'dside-search-group' },
            h('div', { className: 'dside-search-file' },
              h('span', { className: 'nm' }, grp.name),
              h('span', { className: 'rp', title: grp.path }, relDisplay(grp.path, props.root)),
              h('span', { className: 'ln' }, grp.lines.length > 1 ? grp.lines.length + ' 处' : ''),
              repOpen
                ? h('span', {
                    className: 'dside-search-rep',
                    title: '替换这个文件里的全部命中',
                    onClick: (function (p) {
                      return function (ev) { ev.stopPropagation(); doReplace({ paths: [p] }); };
                    })(grp.path),
                  }, '全部替换')
                : null,
            ),
            lineEls,
          ));
        }
        bodyEls = all;
      }

      return h('div', { className: 'dside-overlay', onClick: function () { if (props.onClose) props.onClose(); } },
        h('div', { className: 'dside-search-card', onClick: function (e) { e.stopPropagation(); } },
          h('div', { className: 'dside-search-head' },
            h('span', null, '🔍'),
            h('input', {
              ref: inputRef, className: 'dside-search-input',
              placeholder: '搜索工作空间全部文件…',
              value: query,
              onChange: function (e) { setQuery(e.target.value); },
              onKeyDown: onKeyDown,
            }),
            h('span', { className: 'dside-search-stat' },
              res && !res.loading && !res.error && res.hits
                ? (res.hits.length + ' 处命中' + (res.truncated ? '（结果过多，请细化关键词）' : ' · 已搜 ' + res.searched + ' 个文件'))
                : ''),
          ),
          // ⑫ A3 开关（大小写 / 全词 / 正则）+ 替换框开关
          h('div', { className: 'dside-search-opts' },
            h('span', {
              className: 'dside-opt' + (opt.case ? ' on' : ''), title: '区分大小写（Aa）',
              onClick: function () { setOpt({ case: !opt.case, regex: opt.regex, word: opt.word }); },
            }, 'Aa'),
            h('span', {
              className: 'dside-opt' + (opt.word ? ' on' : ''), title: '全词匹配（ab）',
              onClick: function () { setOpt({ case: opt.case, regex: opt.regex, word: !opt.word }); },
            }, 'ab'),
            h('span', {
              className: 'dside-opt' + (opt.regex ? ' on' : ''), title: '正则表达式（.*）',
              onClick: function () { setOpt({ case: opt.case, regex: !opt.regex, word: opt.word }); },
            }, '.*'),
            h('span', {
              className: 'dside-opt' + (repOpen ? ' on' : ''), title: '显示替换框',
              onClick: function () { setRepOpen(!repOpen); },
            }, '⇄ 替换'),
            res && res.error === 'bad-regex' ? h('span', { className: 'dside-search-rep' }, '正则语法错') : null,
          ),
          repOpen
            ? h('div', { className: 'dside-search-head dside-search-reprow' },
                h('span', null, '⇄'),
                h('input', {
                  className: 'dside-search-input',
                  placeholder: '替换为…（Enter 全部替换）',
                  value: repText,
                  onChange: function (e) { setRepText(e.target.value); },
                  onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); doReplace(null); } },
                }),
                h('button', {
                  className: 'dside-btn primary', disabled: repBusy,
                  onClick: function () { doReplace(null); },
                }, repBusy ? '替换中…' : '全部替换'),
              )
            : null,
          h('div', { className: 'dside-search-body' }, bodyEls),
        ),
      );
    }

    // ── 反悔药：工作区快照面板（列表 / 看差异 / 一键还原）──────────────────
    // 对齐 VSCode 自带的时间线 / 本地历史（Timeline · Local History）那类"能看见某个时刻 +
    // 能回去"的能力；差别在于本应用做的是**工作区级**快照 —— 实战里最需要救的恰恰是
    // "Agent 跑了一条命令、改了一堆文件"这种**事件流看不见**的改动（§5 ⑥ 下一刀未做项①）。
    function SnapshotPanel(props) {
      var listState = React.useState(null);
      var items = listState[0], setItems = listState[1];
      var infoState = React.useState(null);
      var info = infoState[0], setInfo = infoState[1];
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      var tickState = React.useState(0);
      var tick = tickState[0], setTick = tickState[1];

      React.useEffect(function () {
        var alive = true;
        apiGet('/snapshots').then(function (r) {
          if (!alive) return;
          setItems((r && r.items) || []);
          setInfo(r || null);
        });
        return function () { alive = false; };
      }, [tick]);

      // Esc 关闭（面板自己挂 window 冒泡监听，与别的浮层一致）
      React.useEffect(function () {
        function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); props.onClose(); } }
        window.addEventListener('keydown', onKey);
        return function () { window.removeEventListener('keydown', onKey); };
      }, []);

      function takeNow() {
        setBusy(true);
        apiPost('/snapshot', { label: '手动快照', reason: 'manual' }).then(function (r) {
          setBusy(false);
          setTick(function (n) { return n + 1; });
          if (props.onStatus) props.onStatus((r && r.ok) ? ('已创建快照（' + (r.fileCount || 0) + ' 个文件）') : '创建快照失败');
        }).catch(function () { setBusy(false); });
      }

      var rows = (items || []).map(function (s) {
        var delta = [];
        if (s.changed) delta.push('改 ' + s.changed);
        if (s.added) delta.push('增 ' + s.added);
        if (s.deleted) delta.push('删 ' + s.deleted);
        if (!delta.length) delta.push('（无变化）');
        if (s.skippedCount) delta.push('跳过 ' + s.skippedCount);
        if (s.partial || s.truncated) delta.push('未记全');
        return h('div', { className: 'dside-snap-row', key: String(s.ts) },
          h('span', { className: 'dside-snap-time' }, snapTimeText(s.ts)),
          h('span', { className: 'dside-snap-label', title: s.label }, s.label || ''),
          h('span', { className: 'dside-snap-delta', title: '改/增/删 = 与上一份快照相比；跳过 = 超大或读不到、没进快照的文件（还原时绝不会被动到）' }, delta.join(' · ')),
          h('button', { className: 'dside-btn small', onClick: function () { props.onReview(s.ts, s.label, s.iso); } }, '看差异'),
          h('button', { className: 'dside-btn small', onClick: function () { props.onRestore(s.ts, s.label); } }, '还原…'),
        );
      });

      var storeText = (info && info.store)
        ? ('占用 ' + (info.store.bytes / 1024 / 1024).toFixed(1) + ' MB · 保留最近 ' + (info.keep || 40) + ' 份')
        : '';

      return h('div', { className: 'dside-overlay', onClick: function (e) { if (e.target === e.currentTarget) props.onClose(); } },
        h('div', { className: 'dside-search-card' },
          h('div', { className: 'dside-search-head' },
            h('span', null, '⏱'),
            h('b', null, '工作区快照 · 回撤 / 还原'),
            h('span', { className: 'dside-snap-store' }, storeText),
            h('button', { className: 'dside-btn small primary', disabled: busy, onClick: takeNow }, busy ? '保存中…' : '立即快照'),
            h('button', { className: 'dside-btn small', onClick: props.onClose }, '关闭 (Esc)'),
          ),
          h('div', { className: 'dside-snap-body' },
            !items
              ? h('div', { className: 'dside-node-loading' }, '加载中…')
              : (items.length
                ? rows
                : h('div', { className: 'dside-node-loading' }, '还没有快照 —— Agent 每一轮开始前、每次保存后都会自动存一份；也可以点"立即快照"')),
          ),
        ),
      );
    }

    // ── 藏掉平台会话里"在天工没用/点不动"的东西（2026-09-20 用户要求）──────────────
    // ① 整个会话头：标题行（会话标题 / 预设 / 后台任务计数）+ 右侧图标簇 + `对话 / 轨迹` 视图标签。
    //    天工不需要它：会话标题在左侧会话列表里已经有了，轨迹视图是平台的东西，
    //    那簇图标里的「打开右侧边栏」本来就是死按钮。**定位方式**：平台把视图标签画在
    //    会话头那个 <header> 里（ConversationSession.tsx：<header> 包着 titleRow + tabs），
    //    所以"从 role=tab 往上找最近的 <header>"比按 class 稳（class 是 CSS-module 哈希）。
    // ② 「打开/收起右侧边栏」开关（ui-sidebar-right 注册进 conversation.session.header.corner）：
    //    天工不渲染平台右栏 → 点了没反应；它不能靠关插件解决（sidebarRight 被 ui-chat 依赖，
    //    关掉整条对话链 pending，见 §6 64/65）。
    // 做法：**只在自己面板范围内**、按可访问名/结构匹配后打标记隐藏，并用 MutationObserver
    // 跟随平台重渲染；平台改了结构或文案，最多是"东西又出现"，绝不会隐藏错对象。
    // ③ 2026-10-14 加入「在新对话中分支」：用户拍板改走**不可逆回退**，不留"从这儿分出去一条线"的入口。
    //    **为什么在插件侧藏、而不去删官方源码**：同一个效果（用户看不见），真删却要连带动
    //    ui-chat 的 7 处官方单测；藏法的失败模式也安全 —— 官方改了文案最多是它又冒出来，
    //    绝不会隐藏错对象。⇄ 它的**快捷键**藏不住（键要真不响应），那处是真删（ui-workspace）。
    //    第三条入口「侧栏会话右键 → 分叉会话」：天工不渲染官方侧栏 ⇒ 本来就看不见，不动。
    var PLATFORM_DEAD_BUTTONS = ['打开右侧边栏', '收起右侧边栏', '在新对话中分支', 'Branch into a new conversation'];
    function hidePlatformChrome(host) {
      try {
        // ① 整个会话头（含 对话/轨迹 标签）
        var tabs = host.querySelectorAll('[role="tab"]');
        for (var t = 0; t < tabs.length; t++) {
          var hd = tabs[t].closest ? tabs[t].closest('header') : null;
          if (hd && hd.getAttribute('data-dside-hidden') !== '1') {
            hd.setAttribute('data-dside-hidden', '1');
            hd.style.display = 'none';
            trace('ui', 'info', 'platform-chrome-hidden', { what: 'session-header' });
          }
        }
        // ② 右栏开关（万一它在别的容器里出现）
        var nodes = host.querySelectorAll('button,[role="button"]');
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          if (el.getAttribute('data-dside-hidden') === '1') continue;
          var name = String(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
          if (!name) continue;
          for (var j = 0; j < PLATFORM_DEAD_BUTTONS.length; j++) {
            if (name.indexOf(PLATFORM_DEAD_BUTTONS[j]) >= 0) {
              el.setAttribute('data-dside-hidden', '1');
              el.style.display = 'none';
              trace('ui', 'info', 'platform-chrome-hidden', { what: 'button', label: PLATFORM_DEAD_BUTTONS[j] });
              break;
            }
          }
        }
      } catch (e) { /* 隐藏失败不影响使用 */ }
    }

    // ── 左侧活动栏 + 「操作 / 设置」面板（2026-09-20 用户要求，照 VSCode 的规矩）──────
    // VSCode 的活动栏：图标竖排（上=各组，下=设置齿轮），点谁切谁；**点当前那个 = 收起面板**
    // （和 Ctrl+B 一个效果）。天工目前三个组：资源管理器 / 操作 / 设置。
    // 「操作」组按用户要求做成"区块"：区块左上角是小组标题（文件/编辑/查看/帮助），
    // 区块里是具体操作行（图标 + 名称 + 快捷键提示），「打开文件夹」放在「文件」区块里。
    var FONT_SIZE_KEY = 'dside.editorFontSize.v1';
    function readEditorFontSize() {
      try {
        var v = parseInt(window.localStorage.getItem(FONT_SIZE_KEY) || '', 10);
        if (v >= 9 && v <= 24) return v;
      } catch (e) { /* 隐私模式等 */ }
      return 13;
    }
    function writeEditorFontSize(px) {
      try { window.localStorage.setItem(FONT_SIZE_KEY, String(px)); } catch (e) { /* 忽略 */ }
    }

    // ── 编辑器设置（2026-09-22 用户要求："编辑器相关的东西应该有个【编辑器设置】页"）────────
    // 存在本机 localStorage（与字号/标签偏好同一套），逐项对应 monaco 的 editor.* 配置项：
    //   ambiguousCharacters —— editor.unicodeHighlight.ambiguousCharacters（**天工默认关**：
    //       中文标点、全角括号在 monaco 眼里都是"与 ASCII 易混淆的字符"，满屏黄框纯属噪音；
    //       VSCode 默认 true，用户在设置里可以自己开回来）
    //   invisibleCharacters —— editor.unicodeHighlight.invisibleCharacters（**默认开**：
    //       零宽空格 / 方向控制符这类肉眼看不见的坑，主动提醒有价值 —— 用户可在设置里关）
    //   nonBasicASCII        —— editor.unicodeHighlight.nonBasicASCII（**默认关**，与 VSCode 一致：
    //       所有非基本 ASCII 字符都高亮，对中文项目等于全屏标记）
    //   includeComments/includeStrings —— 上面三项的适用范围（默认 true，与 VSCode 一致）
    var EDITOR_PREFS_KEY = 'dside.editorPrefs.v1';
    var EDITOR_PREF_DEF = {
      ambiguousCharacters: false,
      invisibleCharacters: true,
      nonBasicASCII: false,
      includeComments: true,
      includeStrings: true,
      // 单词建议（Word Based Suggestions）：2026-10-19 从"永久关"改成可开关的偏好，
      // 默认值跟 monaco / VSCode 一致 = 开（用户在设置页自己关）。
      wordSuggest: true,
    };
    function readEditorPrefs() {
      var out = {};
      for (var d in EDITOR_PREF_DEF) out[d] = EDITOR_PREF_DEF[d];
      try {
        var raw = window.localStorage.getItem(EDITOR_PREFS_KEY);
        if (raw) {
          var o = JSON.parse(raw);
          if (o && typeof o === 'object') {
            for (var k in out) if (typeof o[k] === 'boolean') out[k] = o[k];
          }
        }
      } catch (e) { /* 隐私模式等：用默认值 */ }
      return out;
    }
    function writeEditorPrefs(p) {
      try { window.localStorage.setItem(EDITOR_PREFS_KEY, JSON.stringify(p)); } catch (e) { /* 忽略 */ }
    }
    // ⑤ 缺口提示：点过「不用了」的语言记在这。**按语言记，不是一刀切关掉** ——
    // 用户对 Python 说"不用了"，不代表他对 Rust 也说不用了（VSCode 的推荐提示也是这个粒度）。
    var NAV_GAP_KEY = 'dside.navGapIgnored.v1';
    function readNavGapIgnored() {
      try {
        var o = JSON.parse(window.localStorage.getItem(NAV_GAP_KEY) || '{}');
        return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
      } catch (e) { return {}; }
    }
    function isNavGapIgnored(lang) { return readNavGapIgnored()[lang] === true; }
    function setNavGapIgnored(lang) {
      try {
        var o = readNavGapIgnored();
        o[lang] = true;
        window.localStorage.setItem(NAV_GAP_KEY, JSON.stringify(o));
      } catch (e) { /* 拿不到存储：退化成"每次都提示"，功能不崩 */ }
    }
    /** 把偏好翻译成 monaco 的 updateOptions 载荷（唯一出口：创建时与改动时都走它）。
     *  includeComments/includeStrings 与那三个开关的优先级交给 monaco 自己判（编辑器里的
     *  unicode 高亮模块就是按这个顺序算的），我们只如实传值。 */
    function editorPrefsToMonacoOptions(p) {
      var prefs = p || EDITOR_PREF_DEF;
      return {
        unicodeHighlight: {
          ambiguousCharacters: !!prefs.ambiguousCharacters,
          invisibleCharacters: !!prefs.invisibleCharacters,
          nonBasicASCII: !!prefs.nonBasicASCII,
          includeComments: !!prefs.includeComments,
          includeStrings: !!prefs.includeStrings,
        },
        // 关 = 'off'；开走 'currentDocument'（= monaco / VSCode 的默认档：只捞当前文件里的词）。
        // 不用布尔 true：这个 build 里布尔会被映射成 'matchingDocuments'（连别的同语言文件一起捞），
        // 比默认档更吵，不是我们要的"还原默认"。
        wordBasedSuggestions: prefs.wordSuggest ? 'currentDocument' : 'off',
      };
    }
    var EDITOR_PREF_APPLIERS = [];   // 编辑器挂载后登记"实时生效"的回调（设置页改一项就调一次）
    function applyEditorPrefsToLiveEditors() {
      var opts = editorPrefsToMonacoOptions(readEditorPrefs());
      for (var i = 0; i < EDITOR_PREF_APPLIERS.length; i++) {
        try { EDITOR_PREF_APPLIERS[i](opts); } catch (e) { /* 编辑器已销毁 */ }
      }
    }

    // 标签三件套的偏好（对应 VSCode 的 workbench.editor.*，**默认值与 VSCode 一致**）：
    //   preview        —— enablePreview（true）：资源管理器单击 = 临时预览标签（斜体、复用同一个）
    //   fromQuickOpen  —— enablePreviewFromQuickOpen（**false**）：Ctrl+P 选中的文件是否也走预览
    //   fromCodeNav    —— enablePreviewFromCodeNavigation（**false**）：代码导航时**来源标签**是否
    //                     保持预览态。VSCode 默认 false = 导航前先把来源转正，免得被目标顶掉
    //   pinnedCompact  —— pinnedTabSizing='compact'：固定标签收窄成只显示图标（VSCode 默认 normal）
    var TAB_PREFS_KEY = 'dside.tabPrefs.v1';
    function readTabPrefs() {
      var out = { preview: true, fromQuickOpen: false, fromCodeNav: false, pinnedCompact: false, restoreSession: true };
      try {
        var raw = window.localStorage.getItem(TAB_PREFS_KEY);
        if (raw) {
          var o = JSON.parse(raw);
          if (o && typeof o === 'object') {
            for (var k in out) if (typeof o[k] === 'boolean') out[k] = o[k];
          }
        }
      } catch (e) { /* 隐私模式等：用默认值 */ }
      return out;
    }
    function writeTabPrefs(p) {
      try { window.localStorage.setItem(TAB_PREFS_KEY, JSON.stringify(p)); } catch (e) { /* 忽略 */ }
    }

    // ── 工作空间记忆（2026-09-22 用户报障："每次打开天工都先开 00WORK，过一会才开我真正在用的目录"）
    // 根因：应用启动那一瞬，插件 host 的 resolveRoot() 还没有"当前会话"可问，只能退到
    //   workspaceRegistry.list()[0]（= 最早建的那个工作空间）→ 文件树先画成 00WORK；
    //   等平台把上次的会话接上（几秒后），root 才被纠正成真正在用的目录。
    // 修法：**本机记住"用户上次真正在用哪个目录"**（客户端一切换 root 就写），启动时先把这个
    //   目录报给 host、并且不让"会话列表里那个还没纠正过来的旧 cwd"把它覆盖掉。
    var LAST_ROOT_KEY = 'dside.lastRoot.v1';
    function readLastRoot() {
      try {
        var v = window.localStorage.getItem(LAST_ROOT_KEY);
        return (v && String(v).trim()) ? String(v) : null;
      } catch (e) { return null; }
    }
    function writeLastRoot(p) {
      try {
        if (p) window.localStorage.setItem(LAST_ROOT_KEY, String(p));
        else window.localStorage.removeItem(LAST_ROOT_KEY);
      } catch (e) { /* 忽略 */ }
    }
    /** 路径是否落在 root 之内（自身或子目录）。用于判断"平台接上来的会话是不是就在这个工作空间里"。 */
    function pathUnderRoot(path, root) {
      if (!path || !root) return false;
      var a = String(path).replace(/[\\/]+$/, '').toLowerCase();
      var b = String(root).replace(/[\\/]+$/, '').toLowerCase();
      if (a === b) return true;
      return a.indexOf(b + '\\') === 0 || a.indexOf(b + '/') === 0;
    }

    // ── 会话恢复 / Hot Exit：关掉软件再打开，上次开着的文件（含没保存的改动）自己回来 ───
    // 2026-09-22 用户报障："我一关软件，上一次打开的那些文件全给我关了！" —— 以前 tabs 只活在
    // React 内存里，关窗就没了。现在按**工作空间根**存本机（localStorage）：
    //   { v:2, roots: { '<根路径>': { tabs:[{n,p,dirty,preview,pinned}], active,
    //                                 drafts:{ '<路径>': { t:'正文', b:'基准磁盘版本令牌' } }, at } } }
    // 对齐 VSCode 的 hot exit（`files.hotExit` 默认 onExit）：脏缓冲区跨会话带回来、不弹保存提示。
    // v2 相比 v1 多了一样东西：**草稿的基准磁盘版本令牌**（b）—— 恢复时拿它跟当前磁盘版本比对，
    // 不一致就说明"你关软件期间这个文件被改过"，保存时按冲突处理（覆盖 / 采用磁盘版 / 看差异），
    // 绝不静默盖掉别人的改动（VSCode 的 TextFileEditorModel 也是这套语义）。v1 的纯字符串草稿照读。
    // 只存"脏标签"的正文（干净标签重新读盘就是最新内容），且单份草稿超过 MAX_DRAFT 就不存
    // （宁可少存也不能把 localStorage 撑爆 —— 存不下就整份放弃并记日志，绝不让它抛异常）。
    var SESSION_KEY = 'dside.session.v1';
    var MAX_ROOTS = 24;        // 记这么多工作空间（超了丢最旧的）
    var MAX_TABS = 40;         // 每个工作空间最多恢复这么多标签
    var MAX_DRAFT = 200 * 1024;   // 单份未保存草稿上限（字符数）
    /** 草稿记录归一：v1 是纯字符串正文；v2 起是 { t: 正文, b: 基准磁盘版本令牌 }。 */
    function normalizeDraft(v) {
      if (typeof v === 'string') return { t: v, b: null };
      if (v && typeof v === 'object' && typeof v.t === 'string') {
        return { t: v.t, b: (typeof v.b === 'string' ? v.b : null) };
      }
      return null;
    }
    /** 任意来源（磁盘副本 / localStorage）的原始对象 → 归一后的 store。坏数据一律当空的。 */
    function normalizeStore(o) {
      var out = { v: 2, roots: {} };
      try {
        if (!o || typeof o !== 'object' || !o.roots || typeof o.roots !== 'object') return out;
        for (var r in o.roots) {
          var rec = o.roots[r];
          if (!rec || typeof rec !== 'object') continue;
          var dr = {};
          var src = rec.drafts || {};
          for (var p in src) { var nd = normalizeDraft(src[p]); if (nd) dr[p] = nd; }
          out.roots[r] = {
            tabs: Array.isArray(rec.tabs) ? rec.tabs : [],
            active: rec.active || null,
            drafts: dr,
            at: rec.at || 0,
          };
        }
      } catch (e) { /* 坏了就当空的（不能让一份坏数据把开机流程卡死） */ }
      return out;
    }
    /** localStorage 里那份（host 不在时的兜底 / 磁盘副本缺失时的退路）。 */
    function readSessionStore() {
      try {
        var raw = window.localStorage.getItem(SESSION_KEY);
        if (!raw) return { v: 2, roots: {} };
        return normalizeStore(JSON.parse(raw));
      } catch (e) { return { v: 2, roots: {} }; }
    }
    // 现行快照（内存）：磁盘副本读上来 / 本机记忆读上来之后都放这儿，后续落盘以它为基准，
    // 避免每次写都去读一遍（也避免读到落后于内存的那一份）。
    var SESSION_STORE = null;
    function currentStore() { return SESSION_STORE || readSessionStore(); }
    function writeSessionStore(store) {
      SESSION_STORE = store;
      var text = '';
      try { text = JSON.stringify(store) } catch (e) { text = ''; }
      // ① 页面本机记忆：同步、尽力而为（host 不在时这里是唯一退路）。配额爆了就丢草稿正文保标签。
      if (text) {
        try { window.localStorage.setItem(SESSION_KEY, text); }
        catch (e) {
          try {
            var slim = { v: store.v || 2, roots: {} };
            for (var r in store.roots) {
              slim.roots[r] = { tabs: store.roots[r].tabs, active: store.roots[r].active, drafts: {}, at: store.roots[r].at };
            }
            window.localStorage.setItem(SESSION_KEY, JSON.stringify(slim));
            trace('ui', 'warn', 'session-store-quota', { recovered: 'drafts-dropped' });
          } catch (e2) {
            try { window.localStorage.removeItem(SESSION_KEY); } catch (e3) { /* 忽略 */ }
            trace('ui', 'error', 'session-store-failed', { error: String((e2 && e2.message) || e2) });
          }
        }
      }
      // ② 磁盘副本（权威）：VSCode 的 hot exit 就是把未保存内容备份到磁盘 —— 硬杀进程也不丢
      if (text) {
        apiPost('/session', { data: store }).then(function (r) {
          if (r && r.error) trace('ui', 'warn', 'session-file-failed', { error: String(r.error) });
        }).catch(function () { /* host 不在就算了，本机那份还在 */ });
      }
      return true;
    }
    /** 记住某个根的标签形态（正文只收 dirty 的，且带上它的基准磁盘版本）。 */
    function rememberSession(root, tabs, activePath, drafts) {
      if (!root) return;
      var store = currentStore();
      var list = [];
      var keepDrafts = {};
      for (var i = 0; i < tabs.length && list.length < MAX_TABS; i++) {
        var t = tabs[i];
        if (!t || !t.path) continue;
        // 浏览器标签不落盘：这条记忆只存 n/p/dirty/preview/pinned，没有地址字段，
        // 恢复出来就成"一个不知道去哪的浏览器标签"（见 openBrowserTab 的注释）
        if (isPseudoPath(t.path)) continue;   // 伪路径标签（浏览器/差异/设置）恢复不了，别落盘
        list.push({ n: t.name, p: t.path, dirty: !!t.dirty, preview: !!t.preview, pinned: !!t.pinned });
        var d = drafts ? drafts[t.path] : null;
        if (t.dirty && d && typeof d.text === 'string' && d.text.length <= MAX_DRAFT) {
          keepDrafts[t.path] = { t: d.text, b: (typeof d.base === 'string' ? d.base : null) };
        }
      }
      // 收尾：这个根的记录挪到对象末尾（= 最近的），超过 MAX_ROOTS 就从最旧的开刀
      // ⚠ 先把"上次没问出结果的标签"接回来（连同草稿），否则这一写就把它们擦掉了
      var orphans = ORPHAN_RECORDS[root] || [];
      for (var oi = 0; oi < orphans.length && list.length < MAX_TABS; oi++) {
        var op = orphans[oi];
        if (!op || !op.tab || !op.tab.p) continue;
        var already = false;
        for (var ai = 0; ai < list.length; ai++) if (list[ai].p === op.tab.p) { already = true; break }
        if (already) continue;
        list.push(op.tab);
        if (op.draft && typeof op.draft.t === 'string' && op.draft.t.length <= MAX_DRAFT) keepDrafts[op.tab.p] = op.draft;
      }
      var roots = {};
      for (var k in store.roots) if (k !== root) roots[k] = store.roots[k];
      roots[root] = { tabs: list, active: activePath || null, drafts: keepDrafts, at: Date.now() };
      var keys = Object.keys(roots);
      if (keys.length > MAX_ROOTS) {
        keys.sort(function (a, b) { return (roots[a].at || 0) - (roots[b].at || 0) });
        for (var d2 = 0; d2 < keys.length - MAX_ROOTS; d2++) delete roots[keys[d2]];
      }
      writeSessionStore({ v: 2, roots: roots });
    }
    /** 把本地记着的草稿交给编辑器：Editor 在 **模型挂上编辑器** 那一刻按路径取一次（取完即删）。
     *  ⚠ 不能在"读盘建 model"时取：切标签会走缓存分支（不读盘）→ 草稿永远消费不到
     *  （2026-09-22 第一版就踩了这个：冷启动恢复的那次快照能套上，之后按 sessionStorage 记忆
     *    恢复的那次套不上 —— 实测 P8 假绿）。 */
    var PENDING_DRAFTS = {};
    var PENDING_DRAFT_PATHS = {};
    function putPendingDraft(path, rec) {
      PENDING_DRAFTS[path] = rec;                 // { text, base }
      PENDING_DRAFT_PATHS[path] = true;
    }
    function takePendingDraft(path) {
      if (!path || !Object.prototype.hasOwnProperty.call(PENDING_DRAFTS, path)) return null;
      var v = PENDING_DRAFTS[path];
      delete PENDING_DRAFTS[path];
      return (v && typeof v.text === 'string') ? v : null;
    }
    /** 还没套上草稿的路径集合（Editor 的 attachModel 用它判断"这个路径还要不要套草稿"）。 */
    function hasPendingDraft(path) {
      return !!path && PENDING_DRAFT_PATHS[path] === true;
    }
    function clearPendingDraftRoot(path) {
      if (path) delete PENDING_DRAFT_PATHS[path];
    }

    // ── 恢复时"问不出结果"的标签：**先留在记忆里**，别让它连带草稿一起消失 ──────────────
    // 2026-09-22 实测踩到的硬 bug：开机恢复时逐个 /stat 问"这文件还在吗"，只要某一次请求**没有**
    // 明确回答（后端刚起来/请求失败），旧代码就当成"没了"把它从标签里划掉，紧接着那次落盘又把
    // 本机记忆整份重写 → **标签和未保存草稿一起永久消失**（实测：5 个标签重启后剩 4 个，草稿丢了）。
    // 现在的判据分三种：alive（恢复成标签）/ **gone（后端明确回 exists:false，真的被删了，丢弃）**
    // / unknown（没问出结果 → 留在 ORPHAN_RECORDS 里，下次开机再问一次）。
    // VSCode 的 hot exit 同样是这个立场：一次读取失败绝不等于"你的未保存内容可以丢了"。
    var ORPHAN_RECORDS = {};    // root -> [{ tab, draft }]（最多 10 条/根，防积压）
    function setOrphanRecords(root, tabRecords, drafts, keepSet) {
      if (!root) return;
      var keep = [];
      for (var i = 0; i < tabRecords.length && keep.length < 10; i++) {
        var t = tabRecords[i];
        if (!t || !t.p || !keepSet || !keepSet[t.p]) continue;
        keep.push({ tab: t, draft: (drafts && drafts[t.p]) ? drafts[t.p] : null });
      }
      ORPHAN_RECORDS[root] = keep;
    }

    // ⑰ 面板尺寸（VSCode 的 sash 拖拽，2026-09-21 用户要求"跟 VSCode 一样可以拖拽改变宽度/高度"）：
    // 默认值 = 天工原来的固定值（左栏 272 / 右栏 704 / 终端高 260），拖拽结果持久化在 localStorage。
    // 作用域取"全局"（一份 localStorage）—— VSCode 是每工作区一份 view state，天工先按全局来（更省心）。
    var LAYOUT_KEY = 'dside.layout.v1';
    var LAYOUT_MIN = { sideW: 170, rightW: 320, termH: 77 };     // 最小尺寸（左栏 170、终端高 77 —— 都与 VSCode 一致）
    var LAYOUT_MAX = { sideW: 4000, rightW: 4000, termH: 4000 };  // VSCode 对侧栏/面板**没有最大宽高**，真正的上限由"编辑区保底"决定
    var LAYOUT_DEF = { sideW: 272, rightW: 704, termH: 260 };     // 双击手柄恢复的默认值（= 天工原来的固定尺寸）
    function readLayout() {
      var out = { sideW: LAYOUT_DEF.sideW, rightW: LAYOUT_DEF.rightW, termH: LAYOUT_DEF.termH };
      try {
        var raw = window.localStorage.getItem(LAYOUT_KEY);
        if (raw) {
          var o = JSON.parse(raw);
          if (o && typeof o === 'object') {
            for (var k in out) if (typeof o[k] === 'number' && isFinite(o[k])) out[k] = o[k];
          }
        }
      } catch (e) { /* 隐私模式等：用默认值 */ }
      return out;
    }
    function writeLayout(p) {
      try { window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(p)); } catch (e) { /* 忽略 */ }
    }
    // ── 键位注册表（2026-09-21）──────────────────────────────────────────────
    // **快捷键的唯一事实来源**：所有键位都在 KEYMAP 里登记（默认键位 / 标题 / 分组 / 归属），
    //   · kind:'app'    → 天工自己的 window capture 路由处理（页面任何位置都生效）
    //   · kind:'editor' → 注册在 monaco 编辑器实例上（焦点在编辑器里时生效）；
    //                     owned:true = 天工自己实现的动作，native = monaco 内建动作 id
    // 用户改动落 localStorage['dside.keys.v1']（{ id: 'Ctrl+Alt+X' }，空串 = 解绑）。
    // 命令面板 / 左侧「操作」组 / 关于对话框 / 快捷键设置页**都从这里取键位** ——
    // 杜绝"界面上写着 Ctrl+N、实际根本没实现"这种谎报（2026-09-21 用户报障的根因之一）。
    var KEYS_KEY = 'dside.keys.v1';
    var KEYS_RECORDING = false;   // 快捷键设置页正在录键 → 全局路由让路（别一边录一边触发命令）
    var KEY_IMPL = {};            // 由 IdeApp 每次渲染重写：需要读组件状态的键位实现在这里（见 keyImpl）
    var CMD_RUN = null;           // 由 IdeApp 每次渲染重写：按 id 跑命令表里的命令（防 stale closure）

    var KEYMAP = [
      // ── 文件 ──────────────────────────────────────────────────────────
      { id: 'file.newFile',    group: '文件', title: '新建文件…',      keys: 'Ctrl+N',       kind: 'app', cmd: 'file.newFile' },
      { id: 'file.newFolder',  group: '文件', title: '新建文件夹…',    keys: 'Ctrl+Shift+N', kind: 'app', cmd: 'file.newFolder' },
      // 打开文件夹：VSCode Windows 写法是 Ctrl+K Ctrl+O（第二步 Ctrl 一直按着）—— 本地写简写，
      // normalizeChord 会把重复修饰键归一，两种写法匹配结果相同（同 Ctrl+K S 那一族）。
      // 打开文件：VSCode `workbench.action.files.openFile` = Ctrl+O（browser/actions/workspaceActions.ts:42）
      { id: 'file.openFile',   group: '文件', title: '打开文件…',      keys: 'Ctrl+O',       kind: 'app', cmd: 'file.openFile' },
      { id: 'file.openFolder', group: '文件', title: '打开文件夹…',    keys: 'Ctrl+K O',     kind: 'app', cmd: 'file.openFolder' },
      // 在文件资源管理器中显示：VSCode 里是两条命令 —— Shift+Alt+R（**仅编辑器失焦时**，见
      // files/electron-browser/fileActions.contribution.ts:34 的 when）+ Ctrl+K R（当前文件，无限制）。
      // 我们的路由是窗口级、没有焦点条件 ⇒ 两个键位都绑上、编辑器里也能用（故意比 VSCode 宽松）。
      { id: 'file.revealInExplorer', group: '文件', title: '在文件资源管理器中显示', keys: 'Shift+Alt+R', extra: ['Ctrl+K R'], kind: 'app', cmd: 'file.revealInExplorer' },
      { id: 'file.save',       group: '文件', title: '保存',           keys: 'Ctrl+S',       kind: 'editor', owned: true },
      // 另存为：VSCode `workbench.action.files.saveAs` = Ctrl+Shift+S（contrib/files/browser/fileCommands.ts:514-518）
      { id: 'file.saveAs',     group: '文件', title: '另存为…',        keys: 'Ctrl+Shift+S', kind: 'app', cmd: 'file.saveAs' },
      { id: 'file.saveAll',    group: '文件', title: '全部保存',       keys: 'Ctrl+K S',     kind: 'app', cmd: 'file.saveAll' },
      // ── 标签页 ────────────────────────────────────────────────────────
      { id: 'file.close',        group: '标签页', title: '关闭当前标签',        keys: 'Ctrl+W', kind: 'app', cmd: 'file.close' },
      { id: 'file.closeOthers',  group: '标签页', title: '关闭其他标签',        keys: '', kind: 'app', cmd: 'file.closeOthers' },
      { id: 'file.closeRight',   group: '标签页', title: '关闭右侧所有标签',    keys: '', kind: 'app', cmd: 'file.closeRight' },
      { id: 'file.closeSaved',   group: '标签页', title: '关闭已保存的标签',    keys: 'Ctrl+K U', kind: 'app', cmd: 'file.closeSaved' },
      { id: 'file.closeAll',     group: '标签页', title: '全部关闭',            keys: 'Ctrl+K W', kind: 'app', cmd: 'file.closeAll' },
      { id: 'file.reopenClosed', group: '标签页', title: '重新打开已关闭的标签', keys: 'Ctrl+Shift+T', kind: 'app', cmd: 'file.reopenClosed' },
      { id: 'file.keepOpen',     group: '标签页', title: '保持打开（预览标签转正）', keys: 'Ctrl+K Enter', kind: 'app', cmd: 'file.keepOpen' },
      { id: 'file.togglePin',    group: '标签页', title: '固定 / 取消固定标签',  keys: 'Ctrl+K Shift+Enter', kind: 'app', cmd: 'file.togglePin' },
      { id: 'file.copyPath',     group: '标签页', title: '复制当前文件路径',    keys: 'Ctrl+K P', kind: 'app', cmd: 'file.copyPath' },
      { id: 'view.nextTab',      group: '标签页', title: '下一个标签',          keys: 'Ctrl+Tab', extra: ['Ctrl+PageDown'], kind: 'app', cmd: 'view.nextTab' },
      { id: 'view.prevTab',      group: '标签页', title: '上一个标签',          keys: 'Ctrl+Shift+Tab', extra: ['Ctrl+PageUp'], kind: 'app', cmd: 'view.prevTab' },
      // ── 编辑器 ────────────────────────────────────────────────────────
      { id: 'editor.undo',          group: '编辑器', title: '撤销',                 keys: 'Ctrl+Z', kind: 'editor', native: 'undo' },
      { id: 'editor.redo',          group: '编辑器', title: '重做',                 keys: 'Ctrl+Y', kind: 'editor', native: 'redo' },
      { id: 'editor.find',          group: '编辑器', title: '在文件中查找',         keys: 'Ctrl+F', kind: 'editor', native: 'actions.find' },
      { id: 'editor.replace',       group: '编辑器', title: '替换',                 keys: 'Ctrl+H', kind: 'editor', native: 'editor.action.startFindReplaceAction' },
      { id: 'editor.gotoDefinition', group: '编辑器', title: '转到定义',            keys: 'F12',    kind: 'editor', owned: true },
      { id: 'editor.outline',       group: '编辑器', title: '转到文件中的符号…',    keys: 'Ctrl+Shift+O', kind: 'editor', native: 'editor.action.quickOutline' },
      { id: 'editor.rename',        group: '编辑器', title: '重命名符号',           keys: 'F2',     kind: 'editor', native: 'editor.action.rename' },
      { id: 'editor.format',        group: '编辑器', title: '格式化文档',           keys: 'Shift+Alt+F', kind: 'editor', native: 'editor.action.formatDocument' },
      { id: 'editor.nextProblem',   group: '编辑器', title: '下一个问题（诊断）',   keys: 'F8',     kind: 'editor', native: 'editor.action.marker.next' },
      { id: 'editor.prevProblem',   group: '编辑器', title: '上一个问题（诊断）',   keys: 'Shift+F8', kind: 'editor', native: 'editor.action.marker.prev' },
      // 删除行：VSCode 的动作是 `editor.action.deleteLines`（contrib/linesOperations/browser/linesOperations.ts:507），
      // 但它的默认键位是 Ctrl+Shift+K；**2026-09-30 用户要求改绑到 Shift+Delete** —— 这里故意与 VSCode 不同
      // （VSCode 的 Shift+Delete 是"剪切"的次级键，clipboard.ts:49）。
      // ⚠ 这个组合在可编辑区被 Blink 当**原生"剪切"**（monaco 里没有它的绑定）→ 实际落点不是 monaco 键位，
      //   而是编辑器自己的 capture 拦截器（见 Editor 里那段 effect，用 hostRef 判焦点）。
      { id: 'editor.deleteLines',   group: '编辑器', title: '删除行',              keys: 'Shift+Delete', kind: 'editor', owned: true },
      { id: 'editor.askAgent',      group: '编辑器', title: '问 Agent（带上选中代码）', keys: 'Ctrl+I', kind: 'editor', owned: true },
      { id: 'editor.inlineSuggest', group: '编辑器', title: '内联建议（AI 补全）',  keys: 'Alt+\\', kind: 'editor', owned: true },
      // ── 视图 ──────────────────────────────────────────────────────────
      { id: 'view.commands',     group: '视图', title: '命令面板',        keys: 'Ctrl+Shift+P', extra: ['F1'], kind: 'app', cmd: 'view.commands' },
      { id: 'view.quickOpen',    group: '视图', title: '快速打开文件',    keys: 'Ctrl+P', kind: 'app', cmd: 'view.quickOpen' },
      { id: 'view.search',       group: '视图', title: '在文件中搜索',    keys: 'Ctrl+Shift+F', kind: 'app', cmd: 'view.search' },
      { id: 'view.problems',     group: '视图', title: '问题面板（错误 / 警告）', keys: 'Ctrl+Shift+M', kind: 'app', cmd: 'view.problems' },
      { id: 'view.explorer',     group: '视图', title: '显隐侧边栏 / 资源管理器', keys: 'Ctrl+B', kind: 'app', cmd: 'view.toggleExplorer' },
      { id: 'view.terminal',     group: '视图', title: '切换集成终端',    keys: 'Ctrl+`', extra: ['Ctrl+J'], kind: 'app', cmd: 'view.terminal' },
      // 新建终端：VSCode `workbench.action.terminal.new` = Ctrl+Shift+`（contrib/terminal/browser/terminalActions.ts:1213-1222）。
      // ⚠ 天工是**单终端**模型（B 方案，2026-09-22 用户拍板）→ "新建" = 关掉当前 PTY、以工作区根重开一个
      //   （VSCode 是新旧并存）。按下去正在跑的 shell 会被替换 —— 这是模型决定的，不是取舍。
      { id: 'term.new',          group: '视图', title: '新建终端',        keys: 'Ctrl+Shift+`', kind: 'app', cmd: 'term.new' },
      { id: 'view.snapshots',    group: '视图', title: '工作区快照（回撤 / 还原）', keys: '', kind: 'app', cmd: 'view.snapshots' },
      { id: 'view.changeHistory', group: '视图', title: '改动历史（本次会话）', keys: '', kind: 'app', cmd: 'view.changeHistory' },
      // ── 内置浏览器（2026-09-30 立项）────────────────────────────────────
      // "打开内置浏览器"VSCode 不给默认键位（只在命令面板/编辑器动作里）→ 我们同样不给键，
      // 但登记进注册表，用户可以在快捷键设置页自己绑。
      { id: 'browser.open',      group: '视图', title: '打开内置浏览器',    keys: '', kind: 'app', cmd: 'browser.open' },
      // Ctrl+L = 浏览器惯例键（聚焦地址栏）。本节其余键位都是"天工优先"，这一条是另一半：
      // 浏览器自己的惯例键归浏览器（设计定稿 §4.2 键位归属），VSCode 的地址栏也是这个键。
      { id: 'browser.focusUrl',  group: '视图', title: '聚焦浏览器地址栏',  keys: 'Ctrl+L', kind: 'app', cmd: 'browser.focusUrl' },
      { id: 'view.keybindings',  group: '视图', title: '快捷键设置…',     keys: '', kind: 'app', cmd: 'view.keybindings' },
      { id: 'view.editorSettings', group: '视图', title: '编辑器设置…',    keys: '', kind: 'app', cmd: 'view.editorSettings' },
      // Markdown 预览：VSCode 1.138 里 Ctrl+Shift+V 是 `markdown.togglePreview`（**原地**把当前标签
      // 翻成预览、再按翻回源码，见 extensions/markdown-language-features/package.json:868-880）；
      // 另一条"在旁边开预览"（Ctrl+K V）天工没落点（只有一栏编辑器），故只做这一条。
      { id: 'md.togglePreview', group: '视图', title: 'Markdown 预览 / 源码', keys: 'Ctrl+Shift+V', kind: 'app', cmd: 'md.togglePreview' },
      // ── Agent / 帮助 ──────────────────────────────────────────────────
      { id: 'agent.newChat', group: 'Agent', title: '新建对话', keys: '', kind: 'app', cmd: 'agent.newChat' },
      // 检查更新：VSCode 的 Ctrl+Shift+U 是输出面板（contrib/output/browser/output.contribution.ts:92），
      // 天工没有输出面板，而标题栏悬停与设置面板一直写着"Ctrl+Shift+U = 检查更新"却从没绑过
      // （2026-09-29 记为"谎报"）⇒ 2026-10-12 用户拍板：真给它绑上（界面文案不撒谎）。
      { id: 'update.check',  group: '帮助', title: '检查更新', keys: 'Ctrl+Shift+U', kind: 'app', cmd: 'update.check' },
      // 差异标签的「上一处 / 下一处改动」：对齐 VSCode chat 改动审阅的 navigatePrevious/Next
      // （Alt+Shift+F5 / Alt+F5，箭头挂编辑器右下角）。天工差异标签早有这两个按钮，
      // 但键位只写在 tooltip 里、没进注册表（2026-10-10 挂账）⇒ 2026-10-12 补上。
      { id: 'review.nextChange', group: '视图', title: '下一处改动', keys: 'Alt+F5', kind: 'app', cmd: 'review.nextChange' },
      { id: 'review.prevChange', group: '视图', title: '上一处改动', keys: 'Alt+Shift+F5', kind: 'app', cmd: 'review.prevChange' },
      { id: 'help.about',    group: '帮助', title: '关于 天工', keys: '', kind: 'app', cmd: 'help.about' },
    ];

    // 用户改动（模块级缓存：读一次，写时同步落盘）
    function readKeyOverrides() {
      var out = {};
      try {
        var raw = window.localStorage.getItem(KEYS_KEY);
        if (raw) {
          var o = JSON.parse(raw);
          if (o && typeof o === 'object') for (var k in o) if (typeof o[k] === 'string') out[k] = o[k];
        }
      } catch (e) { /* 隐私模式等：用默认值 */ }
      return out;
    }
    var KEY_OVERRIDES = readKeyOverrides();
    function writeKeyOverrides(o) {
      try { window.localStorage.setItem(KEYS_KEY, JSON.stringify(o)); } catch (e) { /* 忽略 */ }
    }
    function keyEntry(id) {
      for (var i = 0; i < KEYMAP.length; i++) if (KEYMAP[i].id === id) return KEYMAP[i];
      return null;
    }
    // 当前生效键位（覆盖优先；空串 = 用户解绑）
    function resolvedKeys(id) {
      var e = keyEntry(id);
      if (!e) return '';
      return (typeof KEY_OVERRIDES[id] === 'string') ? KEY_OVERRIDES[id] : (e.keys || '');
    }
    function isKeyOverridden(id) {
      var e = keyEntry(id);
      if (!e) return false;
      return (typeof KEY_OVERRIDES[id] === 'string') && KEY_OVERRIDES[id] !== (e.keys || '');
    }
    function setKeyBinding(id, chord) {
      KEY_OVERRIDES[id] = String(chord || '');
      writeKeyOverrides(KEY_OVERRIDES);
      trace('ui', 'info', 'keybinding-set', { id: id, keys: String(chord || '') });
    }
    function resetKeyBinding(id) {
      delete KEY_OVERRIDES[id];
      writeKeyOverrides(KEY_OVERRIDES);
      trace('ui', 'info', 'keybinding-reset', { id: id });
    }
    function resetAllKeyBindings() {
      KEY_OVERRIDES = {};
      writeKeyOverrides(KEY_OVERRIDES);
      trace('ui', 'info', 'keybinding-reset-all', {});
    }
    function changedKeyCount() {
      var n = 0;
      for (var i = 0; i < KEYMAP.length; i++) if (isKeyOverridden(KEYMAP[i].id)) n++;
      return n;
    }
    // 键位显示（命令面板 / 操作组 / 关于）：改过就用改后的，解绑返回空串
    function keyHint(id) { return resolvedKeys(id); }

    // 自检钩子（同 window.__dshTraceStat 那套）：探针/报障时可以直接读"当前生效键位"，
    // 不必靠点界面猜。只读，不暴露任何写入口。
    try {
      window.__dsideKeys = {
        defaults: function () { var o = {}; KEYMAP.forEach(function (e) { o[e.id] = e.keys || '' }); return o },
        resolved: function (id) { return id ? resolvedKeys(id) : (function () { var o = {}; KEYMAP.forEach(function (e) { o[e.id] = resolvedKeys(e.id) }); return o })() },
        entries: function () { return KEYMAP.map(function (e) { return { id: e.id, group: e.group, title: e.title, keys: e.keys || '', kind: e.kind } }) },
        changed: function () { return changedKeyCount() },
        version: 1,
      };
    } catch (e) { /* 非浏览器环境 */ }

    // ── 和弦（chord）工具 ────────────────────────────────────────────────
    // 存的是"给人看"的写法（Ctrl+Shift+P / Ctrl+K S），比较时统一规范化：
    //   ① 修饰键排序（Ctrl, Alt, Shift）、字母大写
    //   ② **和弦的后续步去掉与上一步重复的修饰键** —— 真机上按 Ctrl+K S 时 Ctrl 是一直按住的
    //      （DOM 事件里第二步照样带 ctrlKey，技术写法是 `Ctrl+K Ctrl+S`），而界面上写的是
    //      `Ctrl+K S`。两个写法必须归一，否则"注册表里有、真按下却匹配不上"
    //      （2026-09-21 回归实测：Ctrl+K Enter / Ctrl+K U 两条就是这么失效的）。
    var MOD_ORDER = ['Ctrl', 'Alt', 'Shift'];
    function normalizeChord(chord) {
      var prevMods = null;
      return String(chord || '').trim().split(/\s+/).map(function (step) {
        var parts = step.split('+').filter(function (x) { return x !== '' });
        var mods = [], key = '';
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i];
          var low = p.toLowerCase();
          if (low === 'ctrl' || low === 'cmd' || low === 'command' || low === 'meta') { if (mods.indexOf('Ctrl') < 0) mods.push('Ctrl'); }
          else if (low === 'alt' || low === 'option') { if (mods.indexOf('Alt') < 0) mods.push('Alt'); }
          else if (low === 'shift') { if (mods.indexOf('Shift') < 0) mods.push('Shift'); }
          else key = p;
        }
        mods.sort(function (a, b) { return MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b) });
        if (prevMods) mods = mods.filter(function (m) { return prevMods.indexOf(m) < 0 });   // ② 去重
        prevMods = prevMods ? prevMods.concat(mods) : mods.slice();
        if (key.length === 1) key = key.toUpperCase();
        return mods.concat(key ? [key] : []).join('+');
      }).join(' ');
    }
    // 事件 → 键位串。**用 e.code 而不是 e.key**：反引号等键在部分键盘布局 / 中文输入法下 e.key 会变成
    // 'Dead' 或别的字符（用户报"Ctrl+` 无效"的一个可能来源），e.code 是按物理键位给的，永远稳定。
    var CODE_KEY = {
      Backquote: '`', Backslash: '\\', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space',
      Enter: 'Enter', NumpadEnter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace',
      Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    };
    // e.key 里的"具名键"（Enter/Tab/PageDown…）与符号 → 规范名。⚠ 必须有这张表：
    // 合成事件（探针/某些 IME/远程输入）经常**没有 e.code**，只靠 e.code 会让 Enter 这类键直接丢掉
    // （2026-09-21 回归实测：Ctrl+K Enter / Ctrl+K U 两条和弦因此失效）。
    var KEY_NAME = {
      enter: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace',
      delete: 'Delete', del: 'Delete', insert: 'Insert', home: 'Home', end: 'End',
      pageup: 'PageUp', pagedown: 'PageDown',
      arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
      space: 'Space', spacebar: 'Space', ' ': 'Space',
      '`': '`', '~': '`', '\\': '\\', '|': '\\', '-': '-', '_': '-', '=': '=', '+': '=',
      '[': '[', '{': '[', ']': ']', '}': ']', ';': ';', ':': ';', "'": "'", '"': "'",
      ',': ',', '<': ',', '.': '.', '>': '.', '/': '/', '?': '/',
    };
    function keyNameOfEvent(e) {
      var code = String(e.code || '');
      if (/^Key[A-Z]$/.test(code)) return code.slice(3);
      if (/^Digit[0-9]$/.test(code)) return code.slice(5);
      if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
      if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
      if (CODE_KEY[code]) return CODE_KEY[code];
      var k = String(e.key || '');
      if (!k || k === 'Unidentified' || k === 'Dead') return '';
      if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) return k;
      if (k.length === 1) return k.toUpperCase();
      return KEY_NAME[k.toLowerCase()] || '';
    }
    function chordOfEvent(e) {
      var name = keyNameOfEvent(e);
      if (!name) return '';
      var mods = [];
      if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      return (mods.length ? mods.join('+') + '+' : '') + name;
    }
    // 可绑定判定：必须有 Ctrl / Alt（裸字母会把打字吃掉），或者是不带修饰键的 F1-F12
    function isBindableChord(chord) {
      var step = String(chord || '').split(' ').pop();
      var parts = step.split('+');
      var key = parts[parts.length - 1];
      var mods = parts.slice(0, -1);
      if (mods.indexOf('Ctrl') >= 0 || mods.indexOf('Alt') >= 0) return true;
      return /^F([1-9]|1[0-2])$/.test(key) && mods.length === 0;
    }
    // 冲突查询：返回占用了这个键位的**别的**条目（含只读的备用键位）
    function conflictOf(chord, exceptId) {
      var n = normalizeChord(chord);
      if (!n) return null;
      for (var i = 0; i < KEYMAP.length; i++) {
        var e = KEYMAP[i];
        if (e.id === exceptId) continue;
        var cur = resolvedKeys(e.id);
        if (cur && normalizeChord(cur) === n) return e;
        var ex = e.extra || [];
        for (var j = 0; j < ex.length; j++) if (normalizeChord(ex[j]) === n) return e;
      }
      return null;
    }
    // 路由索引：当前所有绑定（含备用键位）+ 所有和弦前缀
    function buildKeyRouter() {
      var map = {}, prefixes = {};
      function put(chord, id) {
        var n = normalizeChord(chord);
        if (!n || map[n]) return;                 // 主键位先登记，冲突时主键位优先
        map[n] = id;
        var steps = n.split(' ');
        for (var i = 1; i < steps.length; i++) prefixes[steps.slice(0, i).join(' ')] = true;
      }
      for (var i = 0; i < KEYMAP.length; i++) {
        var e = KEYMAP[i];
        if (e.kind !== 'app') continue;
        var cur = resolvedKeys(e.id);
        if (cur) put(cur, e.id);
        var ex = e.extra || [];
        for (var j = 0; j < ex.length; j++) put(ex[j], e.id);
      }
      return { map: map, prefixes: prefixes };
    }

    // 铁律②：把"当前生效的天工快捷键"整理成壳能注册的形式（单步、app 级、去重）。
    // 多步和弦（Ctrl+K S）Electron 的 globalShortcut 注册不了 → 它们仍走页面原生那条路。
    function shellHotkeyChords() {
      var out = [];
      for (var i = 0; i < KEYMAP.length; i++) {
        var e = KEYMAP[i];
        if (e.kind !== 'app') continue;
        var list = [];
        var cur = resolvedKeys(e.id);
        if (cur) list.push(cur);
        var ex = e.extra || [];
        for (var j = 0; j < ex.length; j++) list.push(ex[j]);
        for (var k = 0; k < list.length; k++) {
          var n = normalizeChord(list[k]);
          if (!n || n.indexOf(' ') >= 0) continue;          // 和弦 / 空键位跳过
          if (out.indexOf(n) < 0) out.push(n);
        }
      }
      return out;
    }

    // ── 键位串 ↔ monaco KeyMod/KeyCode ───────────────────────────────────
    function monacoKeyCodeName(k) {
      if (/^[A-Z]$/.test(k)) return 'Key' + k;
      if (/^[0-9]$/.test(k)) return 'Digit' + k;
      if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) return k;
      var m = { '`': 'Backquote', '\\': 'Backslash', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
        ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', ' ': 'Space' };
      return m[k] || k;
    }
    // 和弦在 monaco 里不适用（monaco 的 addAction 只吃单步键位）→ 取最后一步
    function chordToMonaco(monaco, chord) {
      if (!monaco || !chord) return 0;
      var step = String(chord).split(' ').pop();
      var parts = step.split('+');
      var v = 0, key = '';
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i], low = p.toLowerCase();
        if (low === 'ctrl' || low === 'cmd' || low === 'meta') v |= monaco.KeyMod.CtrlCmd;
        else if (low === 'alt') v |= monaco.KeyMod.Alt;
        else if (low === 'shift') v |= monaco.KeyMod.Shift;
        else key = p;
      }
      var name = monacoKeyCodeName(key);
      var code = monaco.KeyCode[name];
      if (typeof code !== 'number') return 0;
      return v | code;
    }

    // 夹取：既不能小于最小值，也不能把中间编辑区挤没（编辑区始终保留 ≥360px 宽、≥220px 高）
    function clampLayout(p) {
      var winW = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1600;
      var winH = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 900;
      var out = { sideW: p.sideW, rightW: p.rightW, termH: p.termH };
      var roomW = winW - 48 /*活动栏*/ - 360 /*编辑区保底*/ - 4 /*手柄*/;
      out.sideW = Math.max(LAYOUT_MIN.sideW, Math.min(out.sideW, Math.min(LAYOUT_MAX.sideW, roomW - LAYOUT_MIN.rightW)));
      out.rightW = Math.max(LAYOUT_MIN.rightW, Math.min(out.rightW, Math.min(LAYOUT_MAX.rightW, roomW - out.sideW)));
      out.termH = Math.max(LAYOUT_MIN.termH, Math.min(out.termH, Math.min(LAYOUT_MAX.termH, winH - 220)));
      return out;
    }

    function ActivityBar(props) {
      var top = [
        { id: 'explorer', icon: '📁', label: '资源管理器' },
        { id: 'actions', icon: '⚡', label: '操作' },
        { id: 'plugins', icon: '🧩', label: '插件' },   // 2026-09-21：从右侧面板搬过来的
      ];
      function btn(it) {
        var on = props.active === it.id && props.panelOpen;
        return h('button', {
          key: it.id,
          className: 'dside-actbtn' + (on ? ' on' : ''),
          title: it.label + (on ? '（再点一次收起）' : ''),
          onClick: function () { props.onPick(it.id); },
        }, it.icon);
      }
      return h('div', { className: 'dside-activitybar' },
        top.map(btn),
        h('span', { className: 'sp' }),
        btn({ id: 'settings', icon: '⚙️', label: '设置' }),
      );
    }

    // 方块式行列表：item = { icon, label, keys, title, disabled, run } 或 { render: <node> }
    function PanelBlocks(props) {
      return h('div', { className: 'dside-explorer-body' },
        (props.blocks || []).map(function (b, bi) {
          return h('div', { className: 'dside-block', key: 'b' + bi },
            h('div', { className: 'dside-block-title' }, b.title),
            (b.items || []).map(function (it, ii) {
              if (it.render) return h('div', { key: 'r' + ii }, it.render);
              return h('div', {
                key: 'i' + ii,
                className: 'dside-block-row' + (it.disabled ? ' off' : ''),
                title: it.title || it.label || '',
                onClick: function () { if (!it.disabled && it.run) it.run(); },
              },
                h('span', { className: 'dside-block-icon' }, it.icon || ''),
                h('span', { className: 'dside-block-label' }, it.label),
                it.keys ? h('span', { className: 'dside-block-keys' }, it.keys) : null,
              );
            }),
          );
        }),
      );
    }

    // ── 快捷键设置页（2026-09-21 用户要求："设置组里加一个小组叫快捷键，进去之后在中面板里头一个个改"）
    // 逐条改：点「改」→ 直接按下新的组合键（Esc 取消 / Backspace 清除绑定）；撞车了给提示，
    // 可以「仍然设置」（把对方解绑）。**不做 VSCode 那种 when 条件 / JSON 编辑**，够用就行。
    function KeysView(props) {
      var qState = React.useState('');
      var q = qState[0], setQ = qState[1];
      var recState = React.useState(null);   // { id, pending, err, conflict:{chord, other} }
      var rec = recState[0], setRec = recState[1];
      var tickState = React.useState(0);
      var tick = tickState[0], setTick = tickState[1];

      function changed() { setTick(tick + 1); if (props.onChanged) props.onChanged(); }

      function finish(id, chord, force) {
        if (chord) {
          var other = conflictOf(chord, id);
          if (other && !force) { setRec({ id: id, pending: '', err: '', conflict: { chord: chord, other: other } }); return }
          if (other && force) { setKeyBinding(other.id, ''); }
        }
        setKeyBinding(id, chord);
        setRec(null);
        changed();
      }

      // 录键：window capture（先于一切），期间置 KEYS_RECORDING 让全局路由让路
      // 铁律②补充：录键期间要把壳侧那批全局快捷键**撤下来**（空表），否则用户想录的键会被
      // 壳当成热键吃掉、页面根本收不到，录不上。录完/退出时由路由那一层重新送上当前键位表。
      React.useEffect(function () {
        var sh = (typeof window !== 'undefined') ? window.anzioShell : null;
        if (!rec) { KEYS_RECORDING = false; if (sh && sh.setHotkeys) { try { sh.setHotkeys(shellHotkeyChords()) } catch (e) { /* 忽略 */ } } return }
        KEYS_RECORDING = true;
        if (sh && sh.setHotkeys) { try { sh.setHotkeys([]) } catch (e) { /* 忽略 */ } }
        function onKey(e) {
          e.preventDefault(); e.stopPropagation();
          if (e.key === 'Escape') { setRec(null); return }
          if (e.key === 'Backspace' || e.key === 'Delete') { finish(rec.id, '', false); return }
          if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;
          var step = chordOfEvent(e);
          if (!step) return;
          var router = buildKeyRouter();
          var n = normalizeChord(step);
          if (router.prefixes[n]) { setRec({ id: rec.id, pending: step, err: '', conflict: null }); return }   // Ctrl+K 这类二段键第一步
          var full = rec.pending ? (rec.pending + ' ' + step) : step;
          if (!isBindableChord(full)) {
            setRec({ id: rec.id, pending: '', err: '至少要带 Ctrl 或 Alt（也可以直接按 F1–F12）', conflict: null });
            return;
          }
          finish(rec.id, full, false);
        }
        window.addEventListener('keydown', onKey, true);
        return function () {
          window.removeEventListener('keydown', onKey, true);
          KEYS_RECORDING = false;
          var sh2 = (typeof window !== 'undefined') ? window.anzioShell : null;
          if (sh2 && sh2.setHotkeys) { try { sh2.setHotkeys(shellHotkeyChords()) } catch (e) { /* 忽略 */ } }
        };
      }, [rec]);

      var groups = [];
      KEYMAP.forEach(function (e) { if (groups.indexOf(e.group) < 0) groups.push(e.group) });
      var needle = String(q || '').trim().toLowerCase();
      var hit = function (e) {
        if (!needle) return true;
        return (e.title + ' ' + e.id + ' ' + resolvedKeys(e.id)).toLowerCase().indexOf(needle) >= 0;
      };
      var overCount = 0;
      KEYMAP.forEach(function (e) { if (isKeyOverridden(e.id)) overCount++ });

      return h('div', { className: 'dside-keys' },
        h('div', { className: 'dside-keys-head' },
          h('span', { className: 'dside-keys-title' }, '⌨ 快捷键'),
          h('input', {
            className: 'dside-keys-search', placeholder: '搜索命令 / 键位…', value: q,
            onChange: function (ev) { setQ(ev.target.value); },
          }),
          h('button', {
            className: 'dside-btn small', disabled: overCount === 0,
            title: '把所有改过的键位恢复成默认值',
            onClick: function () { resetAllKeyBindings(); changed(); },
          }, '全部恢复默认' + (overCount ? '（' + overCount + '）' : '')),
          h('button', { className: 'dside-btn small', title: '回到编辑器（Esc 也能关）', onClick: function () { if (props.onClose) props.onClose(); } }, '✕ 关闭'),
        ),
        h('div', { className: 'dside-keys-tip' },
          rec
            ? (rec.pending ? ('已按下 ' + rec.pending + ' —— 再按一个键完成和弦（Esc 取消）')
              : '请按下新的组合键：Esc 取消 · Backspace / Delete 清除绑定')
            : '点某一行的「改」，然后直接按下你要用的组合键。改动立刻生效，存在本机（localStorage）。'),
        h('div', { className: 'dside-keys-body' },
          groups.map(function (g) {
            var rows = KEYMAP.filter(function (e) { return e.group === g && hit(e) });
            if (!rows.length) return null;
            return h('div', { className: 'dside-keys-group', key: g },
              h('div', { className: 'dside-keys-group-title' }, g),
              rows.map(function (e) {
                var cur = resolvedKeys(e.id);
                var over = isKeyOverridden(e.id);
                var isRec = rec && rec.id === e.id;
                return h('div', { className: 'dside-keys-item', key: e.id, 'data-key-id': e.id },
                  h('div', { className: 'dside-keys-row' + (isRec ? ' rec' : '') },
                    h('div', { className: 'dside-keys-name' },
                      h('span', null, e.title),
                      e.kind === 'editor' ? h('span', { className: 'dside-keys-tag', title: '这一条由编辑器（monaco）处理：焦点在编辑器里时生效' }, '编辑器') : null,
                      over ? h('span', { className: 'dside-keys-tag mod', title: '你改过这一条' }, '已改') : null,
                    ),
                    h('div', { className: 'dside-keys-bind' },
                      cur ? h('kbd', { className: 'dside-kbd' }, cur) : h('span', { className: 'dside-keys-none' }, '未绑定'),
                      (e.extra || []).map(function (x, xi) { return h('kbd', { className: 'dside-kbd dim', key: 'x' + xi, title: '备用键位（固定，不随改动变）' }, x) }),
                    ),
                    h('div', { className: 'dside-keys-act' },
                      isRec
                        ? h('button', { className: 'dside-btn small', onClick: function () { setRec(null); } }, '取消')
                        : h('button', {
                            className: 'dside-btn small primary',
                            onClick: function () { trace('ui', 'info', 'keybinding-record-start', { id: e.id }); setRec({ id: e.id, pending: '', err: '', conflict: null }); },
                          }, '改'),
                      h('button', {
                        className: 'dside-btn small', disabled: !over,
                        title: '恢复这一条的默认键位',
                        onClick: function () { resetKeyBinding(e.id); setRec(null); changed(); },
                      }, '重置'),
                    ),
                  ),
                  isRec && rec.err ? h('div', { className: 'dside-keys-warn' }, rec.err) : null,
                  isRec && rec.conflict ? h('div', { className: 'dside-keys-warn' },
                    '「' + rec.conflict.chord + '」已经被「' + rec.conflict.other.title + '」占用。',
                    h('button', { className: 'dside-btn small', onClick: function () { finish(e.id, rec.conflict.chord, true); } }, '仍然设置（解除对方绑定）'),
                    h('button', { className: 'dside-btn small', onClick: function () { setRec(null); } }, '取消'),
                  ) : null,
                );
              }),
            );
          }),
        ),
      );
    }

    // 设置面板里的字号行（− / ＋，实时生效 + localStorage 持久化）
    function FontSizeRow(props) {
      var s = React.useState(readEditorFontSize());
      var size = s[0], setSize = s[1];
      function apply(n) {
        var v = Math.max(9, Math.min(24, n));
        setSize(v);
        writeEditorFontSize(v);
        if (props.onApply) props.onApply(v);
      }
      return h('div', { className: 'dside-block-row' },
        h('span', { className: 'dside-block-icon' }, '🔤'),
        h('span', { className: 'dside-block-label' }, '编辑器字号'),
        h('span', { className: 'dside-block-keys' }, String(size)),
        h('button', { className: 'dside-fontbtn', title: '减小', onClick: function () { apply(size - 1); } }, '−'),
        h('button', { className: 'dside-fontbtn', title: '增大', onClick: function () { apply(size + 1); } }, '＋'),
      );
    }

    // 设置面板里的开关行（开 / 关，点一下切换；持久化交给调用方）
    function ToggleRow(props) {
      var on = !!props.value;
      return h('div', { className: 'dside-block-row' + (props.disabled ? ' disabled' : ''), title: props.title || null },
        h('span', { className: 'dside-block-icon' }, props.icon || '⚙️'),
        h('span', { className: 'dside-block-label' }, props.label),
        h('button', {
          className: 'dside-toggle' + (on ? ' on' : ''),
          disabled: props.disabled ? true : undefined,
          title: on ? '已开启，点击关闭' : '已关闭，点击开启',
          onClick: function () { if (!props.disabled && props.onToggle) props.onToggle(!on); },
        }, on ? '开' : '关'),
      );
    }

    // ── 【编辑器设置】页（2026-09-22 用户要求）────────────────────────────────
    // 左侧活动栏「⚙️ 设置 → 编辑器设置…」点开后在中面板出现的**详细设置页**：一行一个
    // monaco 配置项，带官方键名与说明，改完立刻生效 + 存本机（localStorage）。
    // 两组：① 特殊字符提醒（易混淆字符 / 看不见的字符 / 非基本 ASCII + 适用范围，
    //        = 用户看到的那句 "The character U+FF09 ... could be confused" 的开关所在地）；
    //        ② 输入提示（单词建议）。
    // 新增一项 = 在 EDITOR_PREF_DEF 加键（带默认值）+ 在这里加一行 + 在
    // editorPrefsToMonacoOptions 里翻译成 monaco 选项，三处齐了才算接上。
    var EDITOR_PREF_ROWS = [
      { group: '特殊字符提醒（monaco 叫 unicode 高亮）', rows: [
        { key: 'ambiguousCharacters', icon: '❓', label: '易混淆字符',
          desc: '与 ASCII 长得像的字符（中文全角括号））、全角逗号，中文标点等）画黄色提示框。'
            + 'monaco / VSCode 默认开；中文项目里它几乎每行都报，天工默认关，你要就自己打开。',
          monacoKey: 'editor.unicodeHighlight.ambiguousCharacters' },
        { key: 'invisibleCharacters', icon: '👻', label: '看不见的字符',
          desc: '零宽空格、方向控制符这类肉眼看不见的字符画提示框。它们会真的坑人（复制来的代码里混一个，'
            + '编译报错都找不到原因），天工默认开。',
          monacoKey: 'editor.unicodeHighlight.invisibleCharacters' },
        { key: 'nonBasicASCII', icon: '🔤', label: '所有非 ASCII 字符',
          desc: '连中文汉字一起全部标出来（= 高亮 U+0020–U+007E 之外的一切）。中文项目里等于满屏标记，'
            + 'monaco / VSCode 默认关，天工也默认关。',
          monacoKey: 'editor.unicodeHighlight.nonBasicASCII' },
        { key: 'includeComments', icon: '💬', label: '注释里也算',
          desc: '上面三项的适用范围之一：注释里的字符也提醒（默认开）。',
          monacoKey: 'editor.unicodeHighlight.includeComments' },
        { key: 'includeStrings', icon: '🔠', label: '字符串里也算',
          desc: '上面三项的适用范围之一：字符串字面量里的字符也提醒（默认开）。',
          monacoKey: 'editor.unicodeHighlight.includeStrings' },
      ] },
      { group: '输入提示（monaco 叫 suggest）', rows: [
        { key: 'wordSuggest', icon: '🔡', label: '单词建议',
          desc: '打字时自动弹出下拉，候选是当前文件里已经出现过的词（不是语言服务的智能补全），按 Enter 会直接打上。'
            + 'monaco / VSCode 默认开；嫌它吵就关掉 —— 关它不影响语言服务的真补全，也不影响 Enter 换行。',
          monacoKey: 'editor.wordBasedSuggestions' },
      ] },
    ];

    function EditorSettingsView(props) {
      var s = React.useState(readEditorPrefs());
      var prefs = s[0], setPrefs = s[1];
      // 「代码导航装了哪些语言组件」原来在左栏那张卡片上（会闪，已撤）—— 挪到这里现拉一次。
      var cnState = React.useState(null);
      var codeNav = cnState[0], setCodeNav = cnState[1];
      // ⑤：Agent 此刻真正能查哪些语言（口径 = 装配单里生效的 provider，不是"装了哪些包"）
      var cvState = React.useState(null);
      var coverage = cvState[0], setCoverage = cvState[1];
      React.useEffect(function () {
        apiGet('/tools-status').then(function (r) { if (r && r.ok) setCodeNav(r) })
          .catch(function () { /* 读不到就不显示这一行 */ });
        apiGet('/nav-coverage').then(function (r) { if (r && r.ok) setCoverage(r) })
          .catch(function () { /* 读不到就不显示这一行 */ });
      }, []);
      function setOne(key, value) {
        var next = {};
        for (var k in prefs) next[k] = prefs[k];
        next[key] = !!value;
        setPrefs(next);
        writeEditorPrefs(next);
        applyEditorPrefsToLiveEditors();       // 编辑器已经开着 → 立刻生效（不必重开文件）
        if (props.onChanged) props.onChanged(next);
        trace('ui', 'info', 'editor-pref-change', { key: key, value: !!value });
      }
      function resetAll() {
        var next = {};
        for (var k in EDITOR_PREF_DEF) next[k] = EDITOR_PREF_DEF[k];
        setPrefs(next);
        writeEditorPrefs(next);
        applyEditorPrefsToLiveEditors();
        if (props.onChanged) props.onChanged(next);
        trace('ui', 'info', 'editor-pref-reset', {});
      }
      var body = [];
      for (var gi = 0; gi < EDITOR_PREF_ROWS.length; gi++) {
        var g = EDITOR_PREF_ROWS[gi];
        body.push(h('div', { className: 'dside-eset-group-title', key: 'g' + gi }, g.group));
        for (var ri = 0; ri < g.rows.length; ri++) {
          (function (row) {
            body.push(h('div', { className: 'dside-eset-row', key: row.key, 'data-pref': row.key },
              h('div', { className: 'dside-eset-main' },
                h('div', { className: 'dside-eset-label' }, h('span', { className: 'dside-eset-icon' }, row.icon), row.label),
                h('div', { className: 'dside-eset-desc' }, row.desc),
                h('div', { className: 'dside-eset-key' }, row.monacoKey),
              ),
              h('button', {
                className: 'dside-toggle' + (prefs[row.key] ? ' on' : ''),
                'data-pref-toggle': row.key,
                title: prefs[row.key] ? '已开启，点击关闭' : '已关闭，点击开启',
                onClick: function () { setOne(row.key, !prefs[row.key]); },
              }, prefs[row.key] ? '开' : '关'),
            ));
          })(g.rows[ri]);
        }
      }
      return h('div', { className: 'dside-eset' },
        h('div', { className: 'dside-keys-head' },
          h('span', { className: 'dside-keys-title' }, '⚙️ 编辑器设置'),
          h('button', { className: 'dside-btn small', title: '把这一页的所有设置恢复成默认值', onClick: resetAll }, '全部恢复默认'),
          h('button', { className: 'dside-btn small', title: '回到编辑器（Esc 也能关）', onClick: function () { if (props.onClose) props.onClose(); } }, '✕ 关闭'),
        ),
        h('div', { className: 'dside-keys-tip' },
          '这些是编辑器（monaco）自己的开关，改完立刻生效并存在本机（localStorage）——不用重启，'
          + '也不用去点编辑器弹窗里那个「Adjust settings」。'),
        h('div', { className: 'dside-eset-body' },
          body,
          // 代码导航（LSP）：已经装了什么、装在哪（2026-09-22 从左栏那张会闪的卡片挪过来）
          h('div', { className: 'dside-eset-group-title', key: 'cn-title' }, '代码导航（给 Agent 用的语言能力）'),
          // ⑤：先回答"它现在认哪些语言"，再说"装了哪些包"——用户关心的是前者
          h('div', { className: 'dside-eset-row', key: 'cn-cov' },
            h('div', { className: 'dside-eset-main' },
              h('div', { className: 'dside-eset-label' }, h('span', { className: 'dside-eset-icon' }, '🧭'), 'Agent 现在能查'),
              h('div', { className: 'dside-eset-desc' },
                '这些语言的代码，Agent 能查"定义在哪 / 全项目谁在引用"，而不是只靠搜索猜。'),
              h('div', { className: 'dside-eset-key' },
                (coverage && coverage.languages && coverage.languages.length)
                  // 同一个东西的多个变体（typescriptreact / javascriptreact 是同一门语言的 JSX 形态）
                  // 合成一个名字显示 —— 数据层不丢，这里只是别让用户看四个"语言"
                  ? (function () {
                      var seen = {}, names = [], i;
                      for (i = 0; i < coverage.languages.length; i++) {
                        var fam = String(coverage.languages[i].id).replace(/react$/, '');
                        if (seen[fam]) continue;
                        seen[fam] = 1;
                        names.push(fam.charAt(0).toUpperCase() + fam.slice(1));
                      }
                      return names.join(' / ');
                    })()
                  : '还没有 —— 打开缺语言的文件、或它干活时撞上，都会问你要不要装'),
            ),
          ),
          h('div', { className: 'dside-eset-row', key: 'cn-row' },
            h('div', { className: 'dside-eset-main' },
              h('div', { className: 'dside-eset-label' }, h('span', { className: 'dside-eset-icon' }, '🧭'), '已装语言组件'),
              h('div', { className: 'dside-eset-desc' },
                'Agent 改代码前会用代码导航查"定义在哪 / 全项目谁在用"。缺哪种语言，它会先问你要不要装'
                + '（写清装什么包、从哪来、多大），你同意才下载并按官方哈希校验，装完立刻可用。'),
              h('div', { className: 'dside-eset-key' },
                ((codeNav && codeNav.entries && codeNav.entries.length)
                  ? codeNav.entries.map(function (e) { return e.name + '@' + e.version }).join(' · ')
                  : '还没有装任何语言组件 —— 用到时 Agent 会问你')
                + (codeNav && codeNav.root ? ('　装在这里：' + codeNav.root) : '')),
            ),
          ),
        ),
      );
    }

    // ── Agent 设置 · 铁律（2026-10-20）─────────────────────────────────────────
    // 一大段自由文本，存 host 侧（每轮注入在 host 跑，浏览器缓存它读不到）。
    // 保存 = 停手约 1 秒自动落盘；开关只管"注不注入"，不删内容。
    function AgentRulesView(props) {
      // 用户定的口径（2026-10-20）：手动保存、不做开关、默认恒开。
      // 没有"停用"这回事 —— 想停就清空，清空后不注入。
      var textState = React.useState(null);          // null = 还没读到
      var text = textState[0], setText = textState[1];
      var savedState = React.useState('');           // 上次落盘的内容，用来算"未保存"
      var savedText = savedState[0], setSavedText = savedState[1];
      // loading | idle | saving | error-read | error-save
      var statusState = React.useState('loading');
      var status = statusState[0], setStatus = statusState[1];
      var textRef = React.useRef('');                // 保存回调里读最新输入，避开闭包
      var aliveRef = React.useRef(true);
      React.useEffect(function () {
        aliveRef.current = true;
        apiGet('/agent-rules').then(function (r) {
          if (!aliveRef.current) return;
          if (r && r.ok === true) {
            var got = String(r.text || '');
            textRef.current = got;
            setText(got);
            setSavedText(got);
            setStatus('idle');
          } else {
            setStatus('error-read');
          }
        });
        return function () { aliveRef.current = false; };
      }, []);
      function save() {
        var body = textRef.current;
        setStatus('saving');
        apiPost('/agent-rules', { text: body }).then(function (r) {
          var ok = !!(r && r.ok === true);
          trace('ui', ok ? 'info' : 'error', 'agent-rules-save', { chars: body.length });
          if (!aliveRef.current) return;
          if (ok) { setSavedText(body); setStatus('idle'); } else { setStatus('error-save'); }
        });
      }
      var dirty = (text || '') !== savedText;
      var statusText = status === 'saving' ? '保存中…'
        : (status === 'error-read' ? '读取失败（保存会新建一份）'
          : (status === 'error-save' ? '保存失败（细节见轨迹日志）'
            : (status === 'loading' ? '读取中…' : (dirty ? '未保存' : '已保存'))));
      return h('div', { className: 'dside-eset dside-rules' },
        h('div', { className: 'dside-keys-head' },
          h('span', { className: 'dside-keys-title' }, '📜 Agent 设置'),
          h('button', {
            className: 'dside-btn small',
            title: '回到编辑器（Esc 也能关）',
            onClick: function () { if (props.onClose) props.onClose(); },
          }, '✕ 关闭'),
        ),
        h('div', { className: 'dside-eset-body' },
          h('div', { className: 'dside-eset-group-title' }, '铁律'),
          h('div', { className: 'dside-rules-note' },
            '每轮对话开始前，这段字会原样排在你的话前面发给 Agent，当作最高优先级的要求。'
            + '整段粘进来就行，换行、编号原样保留。改完点「保存」（或 Ctrl+S）；没保存就关掉这个标签，改动会丢。'
            + '清空并保存 = 不注入。'),
          h('textarea', {
            className: 'dside-rules-input',
            'data-agent-rules': 'text',
            spellCheck: false,
            placeholder: '例如：回答前先确认事实；不确定就直说不知道；改代码前必须有明确指令……',
            value: text === null ? '' : text,
            onChange: function (e) {
              textRef.current = String(e.target.value || '');
              setText(textRef.current);
            },
            onKeyDown: function (e) {
              if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
                e.preventDefault();
                save();
              }
            },
          }),
          h('div', { className: 'dside-rules-foot' },
            h('span', { className: 'grow' }, String((text || '').length) + ' 字 · ' + statusText),
            h('button', {
              className: 'dside-btn small' + (dirty ? ' primary' : ''),
              'data-agent-rules-save': '1',
              disabled: !dirty || status === 'saving',
              title: dirty ? '把这段内容存下来（Ctrl+S）' : '没有改动',
              onClick: save,
            }, '保存'),
          ),
        ),
      );
    }

    function BlocksPanel(props) {
      return h('div', { className: 'dside-explorer' },
        h('div', { className: 'dside-pane-title' }, props.title),
        h(PanelBlocks, { blocks: props.blocks }),
      );
    }

    // VSCode 的折叠箭头画法（照 tree.css：**同一个「下箭头」**，收起时整体 rotate(-90°)，
    // 而不是换两个图标）—— 线宽 1.2、圆头，视觉与 codicon chevron 一致。
    function chevronSvg(expanded) {
      return h('svg', {
        className: 'dside-chev' + (expanded ? '' : ' collapsed'),
        width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true',
      }, h('path', {
        d: 'M5 6.5 L8 9.5 L11 6.5',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }

    // 资源管理器标题栏那四个动作的图标：**直接取 VSCode 官方 codicon 的 SVG 路径**
    // （microsoft/vscode-codicons `src/icons/*.svg`，MIT）—— 不自己画、不用 emoji，
    // 这样和 VSCode 的形状一模一样（§6 58 的"照抄规格"）。
    var CODICON_PATHS = {
      'new-file': ['M5 14C4.448 14 4 13.552 4 13V3C4 2.448 4.448 2 5 2H8V4.5C8 5.328 8.672 6 9.5 6H12V6.025C12.344 6.056 12.677 6.121 13 6.213V5.414C13 5.016 12.842 4.635 12.561 4.353L9.647 1.439C9.366 1.158 8.984 1 8.586 1H5C3.895 1 3 1.895 3 3V13C3 14.105 3.895 15 5 15H7.261C7.008 14.693 6.791 14.357 6.607 14H5ZM9 2.207L11.793 5H9.5C9.224 5 9 4.776 9 4.5V2.207ZM11.5 7C9.015 7 7 9.015 7 11.5C7 13.985 9.015 16 11.5 16C13.985 16 16 13.985 16 11.5C16 9.015 13.985 7 11.5 7ZM14 12H12V14C12 14.276 11.776 14.5 11.5 14.5C11.224 14.5 11 14.276 11 14V12H9C8.724 12 8.5 11.776 8.5 11.5C8.5 11.224 8.724 11 9 11H11V9C11 8.724 11.224 8.5 11.5 8.5C11.776 8.5 12 8.724 12 9V11H14C14.276 11 14.5 11.224 14.5 11.5C14.5 11.776 14.276 12 14 12Z'],
      'new-folder': ['M2 4.5V6H5.58579C5.71839 6 5.84557 5.94732 5.93934 5.85355L7.29289 4.5L5.93934 3.14645C5.84557 3.05268 5.71839 3 5.58579 3H3.5C2.67157 3 2 3.67157 2 4.5ZM1 4.5C1 3.11929 2.11929 2 3.5 2H5.58579C5.98361 2 6.36514 2.15804 6.64645 2.43934L8.20711 4H12.5C13.8807 4 15 5.11929 15 6.5V7.25716C14.6929 7.00353 14.3578 6.78261 14 6.59971V6.5C14 5.67157 13.3284 5 12.5 5H8.20711L6.64645 6.56066C6.36514 6.84197 5.98361 7 5.58579 7H2V11.5C2 12.3284 2.67157 13 3.5 13H6.20703C6.30564 13.3486 6.43777 13.6832 6.59971 14H3.5C2.11929 14 1 12.8807 1 11.5V4.5ZM16 11.5C16 13.9853 13.9853 16 11.5 16C9.01472 16 7 13.9853 7 11.5C7 9.01472 9.01472 7 11.5 7C13.9853 7 16 9.01472 16 11.5ZM12 9C12 8.72386 11.7761 8.5 11.5 8.5C11.2239 8.5 11 8.72386 11 9V11H9C8.72386 11 8.5 11.2239 8.5 11.5C8.5 11.7761 8.72386 12 9 12H11V14C11 14.2761 11.2239 14.5 11.5 14.5C11.7761 14.5 12 14.2761 12 14V12H14C14.2761 12 14.5 11.7761 14.5 11.5C14.5 11.2239 14.2761 11 14 11H12V9Z'],
      'collapse-all': [
        'M14 4.27051C14.5999 4.62053 15 5.26009 15 6V11C15 13.21 13.21 15 11 15H6C5.26009 15 4.62053 14.5999 4.27051 14H11C12.65 14 14 12.65 14 11V4.27051Z',
        'M9.5 7C9.776 7 10 7.224 10 7.5C10 7.776 9.776 8 9.5 8H5.5C5.224 8 5 7.776 5 7.5C5 7.224 5.224 7 5.5 7H9.5Z',
        'M11 2C12.103 2 13 2.897 13 4V11C13 12.103 12.103 13 11 13H4C2.897 13 2 12.103 2 11V4C2 2.897 2.897 2 4 2H11ZM4 3C3.449 3 3 3.449 3 4V11C3 11.552 3.449 12 4 12H11C11.551 12 12 11.552 12 11V4C12 3.449 11.551 3 11 3H4Z',
      ],
      'refresh': ['M3 8C3 5.23858 5.23858 3 8 3C9.63527 3 11.0878 3.78495 12.0005 5H10C9.72386 5 9.5 5.22386 9.5 5.5C9.5 5.77614 9.72386 6 10 6H12.8904C12.8973 6.00014 12.9041 6.00014 12.911 6H13C13.2761 6 13.5 5.77614 13.5 5.5V2.5C13.5 2.22386 13.2761 2 13 2C12.7239 2 12.5 2.22386 12.5 2.5V4.03138C11.4009 2.78613 9.79253 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14C11.1301 14 13.6999 11.6035 13.9756 8.54488C14.0003 8.26985 13.7975 8.0268 13.5225 8.00202C13.2474 7.97723 13.0044 8.1801 12.9796 8.45512C12.75 11.003 10.6079 13 8 13C5.23858 13 3 10.7614 3 8Z'],
    };
    function codicon(name) {
      var ds = CODICON_PATHS[name] || [];
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
        ds.map(function (d, i) { return h('path', { key: i, d: d }) }));
    }

    function FileNode(props) {
      var node = props.node, depth = props.depth, selected = props.selected, onSelect = props.onSelect;
      var onContext = props.onContext;
      var fsRev = props.fsRev;                      // 磁盘变更计数：变了就重列（资源管理器自动刷新）
      var state = React.useState(false);
      var expanded = state[0], setExpanded = state[1];
      var childrenState = React.useState(null);
      var children = childrenState[0], setChildren = childrenState[1];
      var loadingState = React.useState(false);
      var loading = loadingState[0], setLoading = loadingState[1];
      var isDir = node.type === 'directory';
      var fsRevRef = React.useRef(fsRev);           // 初次挂载不算"变更"（展开时已经拉过一次）
      var inlineNew = props.inlineNew;              // 内联新建 {dir, kind} | null

      function fetchChildren(showLoading) {
        if (showLoading) setLoading(true);
        apiGet('/list-dir', { path: node.path }).then(function (r) {
          setChildren((r && r.entries) || []);
          setLoading(false);
        }).catch(function () { setLoading(false); });
      }

      function toggle() {
        if (props.onFocusNode) props.onFocusNode(node);       // 记录"当前层级"（Ctrl+N 用它决定新建到哪）
        if (!isDir) { onSelect(node); return; }
        var next = !expanded;
        setExpanded(next);
        // 展开一律重列（不再"没拉过才拉"）：VSCode 展开读的也是当前磁盘状态
        if (next) fetchChildren(children === null);
      }

      // 磁盘变了 → 已展开的目录跟着重列（折叠的不白拉，等下次展开）
      React.useEffect(function () {
        if (fsRevRef.current === fsRev) return;
        fsRevRef.current = fsRev;
        if (isDir && expanded) fetchChildren(false);
      }, [fsRev, expanded]);

      // 「折叠所有文件夹」：collapseTick 一变就收起（explorer.collapseAll 同款）
      React.useEffect(function () {
        if (!props.collapseTick) return;
        setExpanded(false);
      }, [props.collapseTick]);

      // 内联新建的目标就是本目录 → 必须展开（否则新行没地方显示）
      var isInlineTarget = !!(isDir && inlineNew && inlineNew.dir === node.path);
      React.useEffect(function () {
        if (!isInlineTarget) return;
        if (!expanded) { setExpanded(true); fetchChildren(children === null); }
      }, [isInlineTarget]);

      // 缩进参考线：祖先每一层一根竖条（VSCode 同款几何 —— 第 i 层的线正好落在第 i 层那一行
      // 折叠箭头的左边缘）。深度 0 没有线；没有子节点的目录展开后线自然消失。
      var lead = [];
      for (var gi = 0; gi < depth; gi++) lead.push(h('span', { key: 'g' + gi, className: 'dside-guide' }));
      // 文件也占一格 16px（VSCode 同款：文件不画箭头，但图标列要对齐）
      lead.push(h('span', { key: 'tw', className: 'dside-twist' }, isDir ? chevronSvg(expanded) : null));

      var row = h('div', {
        // selected 传下来的是"当前选中的路径"（字符串）—— 必须**逐个节点比对**，
        // 否则非空字符串恒为真 → 打开任意文件后整棵树都套上选中态（2026-09-21 用户实测报障）
        className: 'dside-node' + (selected === node.path ? ' sel' : ''),
        onClick: toggle,
        // 单击 = 预览（VSCode 手感：临时标签，斜体、复用同一个）；双击 = 固定打开
        onDoubleClick: function () { if (!isDir && props.onOpen) props.onOpen(node); },
        onContextMenu: function (e) { e.preventDefault(); e.stopPropagation(); if (onContext) onContext(node, e); },
        title: node.path,
      },
        h('span', { className: 'dside-lead' }, lead),
        h('span', { className: 'dside-node-icon' }, isDir ? (expanded ? '📂' : '📁') : iconFor(node)),
        h('span', { className: 'dside-node-name' }, node.name),
      );

      var kids = [];
      if (isDir && expanded) {
        if (isInlineTarget) kids.push(h(InlineNewRow, { key: '__new', depth: depth + 1, kind: inlineNew.kind, onSubmit: props.onInlineSubmit, onCancel: props.onInlineCancel }));
        if (loading) {
          kids.push(h('div', { className: 'dside-node-loading', style: { paddingLeft: 8 + (depth + 1) * 14 + 16 } }, '加载中…'));
        } else if (children) {
          for (var i = 0; i < children.length; i++) {
            var c = children[i];
            kids.push(h(FileNode, {
              key: c.path, node: c, depth: depth + 1, selected: selected, onSelect: onSelect, onOpen: props.onOpen,
              fsRev: fsRev, onContext: onContext, onFocusNode: props.onFocusNode,
              inlineNew: inlineNew, onInlineSubmit: props.onInlineSubmit, onInlineCancel: props.onInlineCancel,
              collapseTick: props.collapseTick,
            }));
          }
        }
      }
      return h('div', null, row, kids.length ? kids : null);
    }

    // 内联新建行（VSCode 在树里就地出输入框：输入框初始为空、光标直接落在名字上）
    // 结束路径**照 VSCode 源码 `explorerViewer.ts:renderInputBox`**：
    //   · Enter → 校验通过才提交（空名被 `validateFileName` 拦下："必须先给个名字"）
    //   · Esc  → 取消，什么都不建
    //   · 点别处（blur）→ **是"确认"不是"取消"**：名字合法就真的建出来，空名才等价取消
    // 另一个与 VSCode 一致的细节：它先插一个**纯内存虚拟节点**（名字为空）再让你改，
    // 磁盘上从头到尾没有占位文件（`Untitled-1` 是 untitled 编辑器另存为时才有的，与这里无关）。
    function InlineNewRow(props) {
      var valState = React.useState('');
      var val = valState[0], setVal = valState[1];
      var errState = React.useState('');
      var err = errState[0], setErr = errState[1];
      var doneRef = React.useRef(false);
      var ref = React.useRef(null);
      React.useEffect(function () {
        if (ref.current) { ref.current.focus(); }
      }, []);
      var lead = [];
      for (var gi = 0; gi < props.depth; gi++) lead.push(h('span', { key: 'g' + gi, className: 'dside-guide' }));
      lead.push(h('span', { key: 'tw', className: 'dside-twist' }, null));
      function finish(commit) {
        if (doneRef.current) return;
        var v = String(val || '').trim();
        if (commit && v) { doneRef.current = true; if (props.onSubmit) props.onSubmit(v); return }
        doneRef.current = true;
        if (props.onCancel) props.onCancel();
      }
      function onEnter() {
        var v = String(val || '').trim();
        if (!v) { setErr('先给个名字'); trace('ui', 'info', 'tree-new-inline-empty', {}); return }   // VSCode 同款：空名不放行
        finish(true);
      }
      return h('div', { className: 'dside-node dside-node-new' },
        h('span', { className: 'dside-lead' }, lead),
        h('span', { className: 'dside-node-icon' }, props.kind === 'dir' ? '📁' : '📄'),
        h('input', {
          ref: ref,
          className: 'dside-inline-input',
          value: val,
          spellCheck: false,
          placeholder: props.kind === 'dir' ? '文件夹名' : '文件名',
          onChange: function (e) { setVal(e.target.value); if (err) setErr(''); },
          onKeyDown: function (e) {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onEnter(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
          },
          // blur = 确认（VSCode：`done(inputBox.isInputValid(), true)`）—— 空名等价取消
          onBlur: function () { finish(true); },
          onClick: function (e) { e.stopPropagation(); },
          onDoubleClick: function (e) { e.stopPropagation(); },
        }),
        h('span', { className: 'dside-inline-hint' }, err ? err : 'Enter 创建 · Esc 取消'),
      );
    }

    function Explorer(props) {
      var root = props.root, selected = props.selected, onSelect = props.onSelect, refreshTick = props.refreshTick;
      var fsRev = props.fsRev;                      // 磁盘变更计数（见 IdeApp 的 /fs-rev 轮询）
      var childrenState = React.useState(null);
      var children = childrenState[0], setChildren = childrenState[1];
      var errorState = React.useState(null);
      var error = errorState[0], setError = errorState[1];

      React.useEffect(function () {
        if (!root) return;
        setError(null);
        apiGet('/list-dir', { path: root }).then(function (r) {
          setChildren((r && r.entries) || []);
        }).catch(function (e) { setError(String(e)); });
      }, [root, refreshTick, fsRev]);

      function act(name, label, fn, disabled) {
        return h('button', {
          className: 'dside-pane-act', key: name, title: label, 'aria-label': label,
          disabled: !!disabled,
          onClick: function (e) { e.stopPropagation(); if (!disabled) fn(); },
        }, codicon(name));
      }
      var inlineNew = props.inlineNew;
      var rows = null;
      if (children || (inlineNew && inlineNew.dir === root)) {
        rows = [];
        // 新建到工作空间根：内联行排在第一位（VSCode 里就是直接在根这一层插一行）
        if (inlineNew && inlineNew.dir === root) {
          rows.push(h(InlineNewRow, { key: '__new', depth: 0, kind: inlineNew.kind, onSubmit: props.onInlineSubmit, onCancel: props.onInlineCancel }));
        }
        (children || []).forEach(function (c) {
          rows.push(h(FileNode, {
            key: c.path, node: c, depth: 0, selected: selected, onSelect: onSelect, onOpen: props.onOpen,
            fsRev: fsRev, onContext: props.onContext, onFocusNode: props.onFocusNode,
            inlineNew: inlineNew, onInlineSubmit: props.onInlineSubmit, onInlineCancel: props.onInlineCancel,
            collapseTick: props.collapseTick,
          }));
        });
      }
      return h('div', { className: 'dside-explorer' },
        // 标题栏 + 右侧四个动作。顺序照 VSCode 源码 `views/explorerView.ts` 里四个
        // MenuId.ViewTitle 动作的 order：**新建文件(10) · 新建文件夹(20) · 刷新(30) · 折叠(40)**
        // —— 注意"刷新"在"折叠"**前面**（凭印象很容易写反，见 §6 71）。
        h('div', { className: 'dside-pane-title dside-explorer-title' },
          h('span', { className: 'ttl' }, '资源管理器'),
          h('div', { className: 'dside-pane-actions' },
            act('new-file', '新建文件…（Ctrl+N）', function () { if (props.onNewFile) props.onNewFile(); }, !root),
            act('new-folder', '新建文件夹…（Ctrl+Shift+N）', function () { if (props.onNewFolder) props.onNewFolder(); }, !root),
            act('refresh', '刷新资源管理器', function () { if (props.onRefresh) props.onRefresh(); }),
            act('collapse-all', '折叠资源管理器中的所有文件夹', function () { if (props.onCollapseAll) props.onCollapseAll(); }),
          ),
        ),
        h('div', { className: 'dside-explorer-body',
          // 右键空白处 = 对工作空间根操作（VSCode 同款）
          onContextMenu: function (e) { e.preventDefault(); if (props.onContext) props.onContext(null, e); } },
          error ? h('div', { className: 'dside-editor-error' }, String(error)) : null,
          !children ? h('div', { className: 'dside-node-loading' }, root ? '加载中…' : '等待工作区…') : null,
          rows,
        ),
      );
    }

    // ⑤ worker / marker 回给我们的路径可能是 URI 形态（实测 `file:///d%3A/...`：**URL 编码 +
    // 盘符小写**）→ 统一转成本应用的本地路径（`D:\...`）。只剥 `file://` 会得到 `\d%3A\...`
    // 这种鬼路径（模型查不到、标签去重失败），详见 §6 36。
    function localPathFromUri(s) {
      var t = String(s || '');
      t = t.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
      try { t = decodeURIComponent(t) } catch (e) { /* 含非法转义就用原串 */ }
      t = t.replace(/^\/([A-Za-z]):/, '$1:');
      t = t.replace(/\//g, '\\');
      t = t.replace(/^([a-zA-Z]):/, function (_m, d) { return d.toUpperCase() + ':' });
      return t;
    }

    // ⑤ tsconfig → monaco 编译选项：tsconfig 的值是字符串（"es2020"/"react-jsx"…），
    // monaco 要的是枚举数值，所以映射只能在 client 做。
    var TS_TARGET_MAP = { es3: 'ES3', es5: 'ES5', es6: 'ES2015', es2015: 'ES2015', es2016: 'ES2016', es2017: 'ES2017', es2018: 'ES2018', es2019: 'ES2019', es2020: 'ES2020', es2021: 'ES2021', es2022: 'ES2022', es2023: 'ES2023', esnext: 'ESNext' };
    var TS_MODULE_MAP = { none: 'None', commonjs: 'CommonJS', amd: 'AMD', umd: 'UMD', system: 'System', es6: 'ES2015', es2015: 'ES2015', es2020: 'ES2020', es2022: 'ES2022', esnext: 'ESNext', node16: 'Node16', nodenext: 'NodeNext' };
    var TS_RES_MAP = { classic: 'Classic', node: 'NodeJs', node10: 'NodeJs', node16: 'Node16', nodenext: 'NodeNext', bundler: 'Bundler' };
    var TS_JSX_MAP = { preserve: 'Preserve', react: 'React', 'react-jsx': 'ReactJSX', 'react-jsxdev': 'ReactJSXDev', 'react-native': 'ReactNative' };
    // 与 tsc 同名同义、可以直接透传的布尔开关
    var TS_BOOL_OPTS = ['strict', 'alwaysStrict', 'noImplicitAny', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply',
      'strictPropertyInitialization', 'noImplicitThis', 'useUnknownInCatchVariables', 'noUnusedLocals', 'noUnusedParameters',
      'noImplicitReturns', 'noFallthroughCasesInSwitch', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'esModuleInterop',
      'allowSyntheticDefaultImports', 'allowJs', 'checkJs', 'resolveJsonModule', 'isolatedModules', 'experimentalDecorators',
      'emitDecoratorMetadata', 'skipLibCheck', 'forceConsistentCasingInFileNames', 'useDefineForClassFields', 'verbatimModuleSyntax',
      'downlevelIteration', 'importHelpers', 'preserveConstEnums', 'noEmit', 'allowUnreachableCode', 'allowUnusedLabels'];

    function stripJsonc(s) {
      return String(s)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, '$1')
        .replace(/,(\s*[}\]])/g, '$1');
    }

    function mapTsconfigOptions(T, co) {
      var out = {};
      if (!T || !co || typeof co !== 'object') return out;
      // 注意：monaco 的枚举挂在命名空间下（T.ScriptTarget.ES2020），**不是** T.ES2020 ——
      // 查错地方会静默丢选项（实测症状：tsconfig 里 target/moduleResolution 没生效、只剩布尔项）
      var setEnum = function (key, bag, map, val) {
        if (typeof val !== 'string' || !bag) return;
        var name = map[String(val).toLowerCase()];
        if (name && typeof bag[name] === 'number') out[key] = bag[name];
      };
      setEnum('target', T.ScriptTarget, TS_TARGET_MAP, co.target);
      setEnum('module', T.ModuleKind, TS_MODULE_MAP, co.module);
      setEnum('moduleResolution', T.ModuleResolutionKind, TS_RES_MAP, co.moduleResolution);
      setEnum('jsx', T.JsxEmit, TS_JSX_MAP, co.jsx);
      for (var i = 0; i < TS_BOOL_OPTS.length; i++) {
        var k = TS_BOOL_OPTS[i];
        if (typeof co[k] === 'boolean') out[k] = co[k];
      }
      return out;
    }

    // ── 媒体预览组件：图片 / 音频 / 视频（2026-09-23 用户要求"跟 VSCode 一样能看图"）──
    // 规格全部来自本地 VSCode 源码（铁律①）：`extensions/media-preview/media/imagePreview.{js,css}`
    //   · 初始态 = 适应窗口（scale-to-fit，object-fit:contain）；点图放大、按住 Ctrl 点 = 缩小；
    //   · Ctrl+滚轮 = 连续缩放（VSCode 的捏合手势；比例步进 0.075）；
    //   · +/- 按 zoomLevels 逐档（0.1…20），状态栏那行给"尺寸 + 缩放比例"；
    //   · 缩放 ≥3 倍上 image-rendering:pixelated（否则放大后糊成一片马赛克滤镜）；
    //   · 透明像素铺 16px 棋盘格 + 1px 描边（imagePreview.css 的 conic-gradient）；
    //   · 音频/视频 = 原生 <audio>/<video controls>，默认**不自动播放、不循环**
    //     （VSCode mediaPreview.video.autoPlay / .loop 默认都是 false）。
    // 有意不同：VSCode 把这些做成 webview 自定义编辑器（一个 webview 一份状态）；我们直接渲染在
    // 中间面板的编辑器槽位里（monaco 不卸载），缩放状态按标签路径各自重置为"适应窗口"。
    function MediaPreview(props) {
      var kind = props.kind;                 // image | audio | video
      var path = props.path;
      var rev = props.rev;                   // 手动刷新 / 外部改写 → 变则重新拉字节
      var wrapRef = React.useRef(null);
      var imgRef = React.useRef(null);
      var zoomState = React.useState('fit');
      var zoom = zoomState[0], setZoom = zoomState[1];
      var dimState = React.useState(null);   // 图片固有尺寸 { w, h }
      var dim = dimState[0], setDim = dimState[1];
      var sizeState = React.useState(null);  // 磁盘字节数（VSCode 状态栏那条 Binary Size）
      var size = sizeState[0], setSize = sizeState[1];
      var failState = React.useState('');
      var fail = failState[0], setFail = failState[1];
      var menuState = React.useState(false);
      var menu = menuState[0], setMenu = menuState[1];
      var ctrlState = React.useState(false);
      var ctrlDown = ctrlState[0], setCtrlDown = ctrlState[1];
      var diskRevState = React.useState(0);
      var diskRev = diskRevState[0], setDiskRev = diskRevState[1];

      // 破缓存：手动刷新 + 检测到的磁盘版本都进 URL（VSCode 也是给资源挂 ?version=）
      var src = rawFileUrl(path, String(rev || 0) + '.' + diskRev);

      // 换文件 → 回到"适应窗口"、清掉上一张的尺寸/错误
      React.useEffect(function () {
        setZoom('fit'); setDim(null); setFail(''); setSize(null); setMenu(false);
      }, [path, rev]);

      // 磁盘版本轮询（2.5s，与文本那条外改轮询同频）：版本变了就换 URL 重新解码；
      // 文件没了就报"已不在"（VSCode 那边是 file watcher 把预览关掉）
      React.useEffect(function () {
        var stop = false;
        var last = null;
        function tick() {
          apiGet('/stat', { path: path }).then(function (st) {
            if (stop || !st) return;
            if (st.exists === false) { setFail('missing'); return }
            if (typeof st.size === 'number') setSize(st.size);
            if (last !== null && st.version && String(st.version) !== last) setDiskRev(function (n) { return n + 1 });
            if (st.version) last = String(st.version);
          });
        }
        tick();
        var t = setInterval(tick, 2500);
        return function () { stop = true; clearInterval(t); };
      }, [path]);

      // Ctrl 按下 ↔ 松开切换光标（VSCode：Ctrl 按下时放大变成缩小）
      React.useEffect(function () {
        if (kind !== 'image') return undefined;
        function sync(e) { var v = !!e.ctrlKey; setCtrlDown(function (prev) { return prev === v ? prev : v }) }
        function clear() { setCtrlDown(false) }
        window.addEventListener('keydown', sync);
        window.addEventListener('keyup', sync);
        window.addEventListener('blur', clear);
        return function () {
          window.removeEventListener('keydown', sync);
          window.removeEventListener('keyup', sync);
          window.removeEventListener('blur', clear);
        };
      }, [kind]);

      function clampScale(v) { return Math.min(Math.max(v, 0.1), 20); }
      // VSCode firstZoom()：从"适应窗口"进入显式比例时，先按当前渲染尺寸求出实际比例
      function fitScale() {
        var img = imgRef.current;
        if (!img) return 1;
        if (img.naturalWidth) return (img.clientWidth / img.naturalWidth) || 1;
        return 1;   // 只有 viewBox、没有固有尺寸的 SVG → 按 1x（VSCode 同处理）
      }
      function levelUp(from) {
        for (var i = 0; i < IMAGE_ZOOM_LEVELS.length; i++) if (IMAGE_ZOOM_LEVELS[i] > from) return IMAGE_ZOOM_LEVELS[i];
        return 20;
      }
      function levelDown(from) {
        for (var i = IMAGE_ZOOM_LEVELS.length - 1; i >= 0; i--) if (IMAGE_ZOOM_LEVELS[i] < from) return IMAGE_ZOOM_LEVELS[i];
        return 0.1;
      }
      function zoomIn() { setZoom(levelUp(zoom === 'fit' ? fitScale() : zoom)); }
      function zoomOut() { setZoom(levelDown(zoom === 'fit' ? fitScale() : zoom)); }
      function zoomBy(factor) { setZoom(clampScale((zoom === 'fit' ? fitScale() : zoom) * factor)); }
      function zoomFit() { setZoom('fit'); }

      // Ctrl+滚轮：React 的 onWheel 是被动监听（preventDefault 无效）→ 挂原生 passive:false
      React.useEffect(function () {
        var el = wrapRef.current;
        if (!el || kind !== 'image') return undefined;
        function onWheel(e) {
          if (e.ctrlKey) e.preventDefault();
          if (!e.ctrlKey && !ctrlDown) return;
          var delta = e.deltaY > 0 ? 1 : -1;
          zoomBy(1 - delta * IMAGE_PINCH_FACTOR);
        }
        el.addEventListener('wheel', onWheel, { passive: false });
        return function () { el.removeEventListener('wheel', onWheel); };
      }, [kind, path, rev, zoom, ctrlDown]);

      // 没有固有尺寸的图（只有 viewBox 的 SVG）放大时要给显式像素尺寸，CSS zoom 才有东西可缩
      React.useEffect(function () {
        var img = imgRef.current;
        if (!img || zoom === 'fit') return;
        if (!img.naturalWidth || !img.naturalHeight) {
          img.style.minWidth = (img.clientWidth || 100) + 'px';
          img.style.minHeight = (img.clientHeight || 100) + 'px';
        }
      }, [zoom]);

      // 状态栏（VSCode 有"图片尺寸"和"缩放比例"两个条目；我们合成一行）
      React.useEffect(function () {
        if (!props.onStatus) return;
        var bits = [kind === 'image' ? '图片' : (kind === 'audio' ? '音频' : '视频')];
        if (kind === 'image' && dim) bits.push(dim.w + '×' + dim.h);
        if (size !== null) bits.push(fileSizeText(size));
        if (kind === 'image') bits.push(zoom === 'fit' ? '适应窗口' : Math.round(zoom * 100) + '%');
        if (props.canToggleText) bits.push('可「以文本打开」');
        props.onStatus(bits.join(' · '));
      }, [kind, zoom, size, dim ? dim.w + 'x' + dim.h : '', props.canToggleText]);

      // 把缩放能力暴露给命令面板（VSCode：imagePreview.zoomIn / zoomOut 两条命令）
      React.useEffect(function () {
        if (!props.apiRef) return undefined;
        props.apiRef.current = { zoomIn: zoomIn, zoomOut: zoomOut, fit: zoomFit };
        return function () { props.apiRef.current = null; };
      });

      // 预览关掉 / 换成别的文件时，把状态栏那条清掉（VSCode 的 size/zoom 条目也只在该预览活动时显示）
      React.useEffect(function () {
        return function () { if (props.onStatus) props.onStatus(''); };
      }, []);

      var img = h('img', {
        ref: imgRef,
        className: 'dside-media-img'
          + (zoom === 'fit' ? ' fit' : '')
          + (typeof zoom === 'number' && zoom >= IMAGE_PIXELATION_THRESHOLD ? ' pixelated' : ''),
        src: src,
        alt: props.name || '',
        draggable: false,
        style: typeof zoom === 'number' ? { zoom: String(zoom) } : undefined,
        onClick: function (e) { if (e.ctrlKey) zoomOut(); else zoomIn(); },
        onLoad: function (e) {
          var el = e.target;
          if (el.naturalWidth) setDim({ w: el.naturalWidth, h: el.naturalHeight });
          setFail('');
        },
        onError: function () { setFail('load'); },
      });

      var bar = null;
      var menuEl = null;
      if (kind === 'image') {
        bar = h('div', { className: 'dside-media-bar' },
          h('button', { title: '缩小（Ctrl+滚轮 / 按住 Ctrl 点图）', onClick: zoomOut }, '－'),
          h('span', { className: 'dside-media-zoom', title: '选择缩放级别', onClick: function () { setMenu(!menu) } },
            zoom === 'fit' ? '适应窗口' : Math.round(zoom * 100) + '%'),
          h('button', { title: '放大（点图 / Ctrl+滚轮）', onClick: zoomIn }, '＋'),
          h('button', { title: '适应窗口', onClick: zoomFit }, '⤢'),
          dim ? h('span', { className: 'dside-media-dim' }, dim.w + '×' + dim.h) : null,
          size !== null ? h('span', { className: 'dside-media-dim' }, fileSizeText(size)) : null,
          props.canToggleText
            ? h('button', { title: '以文本方式打开（VSCode 对 .svg 才有这个来回切换）', onClick: props.onOpenAsText }, '以文本打开')
            : null,
        );
        if (menu) {
          menuEl = h('div', { className: 'dside-menu', style: { position: 'absolute', top: '44px', right: '12px', zIndex: 5 } },
            IMAGE_QUICK_SCALES.map(function (s) {
              return h('div', {
                key: String(s), className: 'dside-menu-item',
                onClick: function () { setZoom(s); setMenu(false) },
              }, h('span', null, s === 'fit' ? '适应窗口' : Math.round(s * 100) + '%'));
            }));
        }
      }

      var body = null;
      if (fail === 'missing') {
        body = h('div', { className: 'dside-media-msg' },
          h('b', null, '这个文件已经不在了'),
          h('span', null, '磁盘上找不到它（被移走 / 删除 / 改名了）。'));
      } else if (fail === 'load') {
        body = h('div', { className: 'dside-media-msg' },
          h('b', null, kind === 'image' ? '图片加载失败' : (kind === 'audio' ? '音频加载失败' : '视频加载失败')),
          h('span', null, '浏览器解码不了这个文件。'),
          h('button', { className: 'dside-btn small', onClick: props.onOpenAsText }, '仍以文本方式打开'));
      } else if (kind === 'audio') {
        body = h('audio', {
          className: 'dside-media-audio', controls: true, src: src,
          onLoadedMetadata: function () { setFail('') },
          onError: function () { setFail('load') },
        });
      } else if (kind === 'video') {
        body = h('video', {
          className: 'dside-media-video', controls: true, playsInline: true, src: src,
          onLoadedMetadata: function () { setFail('') },
          onError: function () { setFail('load') },
        });
      } else {
        body = img;
      }

      return h('div', {
        className: 'dside-media' + (fail ? ' error' : ' ready')
          + (kind === 'image' && !fail ? (ctrlDown ? ' zoom-out' : ' zoom-in') : ''),
        ref: wrapRef,
      }, bar, menuEl, body);
    }

    // ═══ 内置浏览器（2026-09-30 立项；设计定稿 `99归档\内置浏览器与Agent幻影-设计定稿-2026-09-30.md`）═══
    // 形态：中间面板里的一种标签（路径走 browser:// 伪协议），页面本体是**壳里的原生视图**
    //       （Electron WebContentsView），DOM 这层只干两件事：画工具栏、给原生视图让出一块矩形。
    // 三条动之前必须理解的约束：
    //   ① 原生视图**永远盖在页面 DOM 之上**，没有任何 z-index 压得过它 ⇒ 天工自己的浮层（命令面板/
    //      菜单/对话框/通知）压上来时必须主动把视图藏起来，藏之前要拿壳的截图当占位，否则会闪白。
    //   ② 工具栏必须留在 DOM 里、且**不落在**视图矩形内 —— 落进去就被原生层吃掉点击，用户点不到。
    //   ③ 拿不到壳桥（浏览器里开 3081 的开发台）→ 明说没有内置浏览器，不静默失败。
    var BROWSER_SCHEME = 'browser://';
    function isBrowserPath(path) { return String(path || '').indexOf(BROWSER_SCHEME) === 0; }
    // ⑥ 重做（2026-10-10）：差异审阅标签的伪路径（与 `browser://` 同构）。
    // 一个改动文件 = 一个标签，只干两件事：看差异 + 逐块保留/撤销。
    var REVIEW_SCHEME = 'diff://';
    function isReviewPath(path) { return String(path || '').indexOf(REVIEW_SCHEME) === 0; }
    // 2026-10-12：设置标签也是伪路径（`settings://`）—— 正文不是文件，是引擎那套设置面板本体
    // （已改挂到主区的 'settings' key）。做成标签而不是"盖一层视图"，是为了跟文件标签同一套
    // 开关/固定/关闭语义（用户要的 VSCode 手感）。
    var SETTINGS_SCHEME = 'settings://';
    function isSettingsPath(path) { return String(path || '').indexOf(SETTINGS_SCHEME) === 0; }
    // 伪路径的统一判据：会话恢复不落盘、不进"重开已关闭的标签"栈、标签右键不显示路径族 ——
    // 这类边角散落在多处，漏一处就会冒出"重开软件后一个打不开的设置标签"这种怪事。
    function isPseudoPath(path) { return isBrowserPath(path) || isReviewPath(path) || isSettingsPath(path); }
    // 设置类标签的页名 → 标签标题（`settings://<页>`）：engine = 引擎那套设置，另两个是天工自己的页。
    var SETTINGS_TAB_TITLE = { engine: 'harness 设置', 'editor-prefs': '编辑器设置', keys: '快捷键', agent: 'Agent 设置' };
    // 差异标签的「上一处 / 下一处改动」要被键位调用（Alt+Shift+F5 / Alt+F5），
    // 而那个 step() 是 ReviewPane 的局部函数、键位实现住在 IdeApp 那层 ⇒ 用一个模块级指针接上。
    // ReviewPane 挂载时写、卸载时清（清之前先比一句，免得后挂的那个被先卸的抹掉）。
    var REVIEW_STEP = { fn: null };
    function browserBridge() {
      if (typeof window === 'undefined') return null;
      var s = window.anzioShell;
      return (s && s.browser && s.browser.available) ? s.browser : null;
    }
    var browserSeq = 0;
    function newBrowserId() { browserSeq += 1; return BROWSER_SCHEME + Date.now().toString(36) + '-' + browserSeq; }

    // 原生视图该占的那块矩形被谁压住了？
    // 判据取 VSCode 同一套：拿矩形上的几个点做**最上层命中测试**，取到的元素不在浏览器面板里 = 被遮。
    // 为什么不按 class 名逐个判断浮层：天工自己的浮层、monaco 的悬停、平台 portal 到 document.body 的
    // 菜单/模态/toast 全都要算，而平台那批我们拿不到固定类名 —— 命中测试对"任何东西"都成立。
    function pointCoveredBy(node) {
      if (!node) return true;
      return !(node.closest && node.closest('.dside-browser'));
    }
    // ⚠ 入参必须是 **DOMRect 原样**（有 left/right/top/bottom）；传 {x,y,width,height} 会让坐标算成
    //   NaN，elementFromPoint 直接抛 TypeError（2026-10-08 实测：视图一次都没显示出来，就是这个）
    function rectOccluded(rect) {
      var x = Number(rect.left), y = Number(rect.top);
      var w = Number(rect.width), h = Number(rect.height);
      if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return true;   // 算不出尺寸 = 先别显示
      if (w < 2 || h < 2) return true;   // 面板被收起/藏起来了 = 不该显示
      var pts = [
        [x + 6, y + 6], [x + w - 6, y + 6],
        [x + 6, y + h - 6], [x + w - 6, y + h - 6],
        [x + w / 2, y + h / 2],
      ];
      for (var i = 0; i < pts.length; i++) {
        var px = pts[i][0], py = pts[i][1];
        if (px < 0 || py < 0) return true;
        if (pointCoveredBy(document.elementFromPoint(px, py))) return true;
      }
      return false;
    }

    function BrowserPane(props) {
      var id = props.path;
      var bridge = browserBridge();
      var viewRef = React.useRef(null);
      var inputRef = React.useRef(null);
      var setRef = React.useRef(null);
      var editingRef = React.useRef(false);
      var visibleRef = React.useRef(false);
      var syncRef = React.useRef(null);        // 几何重算入口：壳广播重排时直接调它
      var stState = React.useState({
        url: props.url || '', title: '', canBack: false, canForward: false,
        loading: false, fail: null, shot: null, addr: props.url || '',
        phantomOn: true,   // 幻影开关（工具栏那颗 👻）：全局设置，挂载时从壳里读真实值
      });
      var st = stState[0], setSt = stState[1];
      function apply(part) {
        setSt(function (prev) {
          var next = {};
          for (var k in prev) next[k] = prev[k];
          // 值为 undefined 表示"这次不动这个字段"（地址栏正在编辑时不能拿壳回传的 URL 覆盖用户输入）
          for (var q in part) if (part[q] !== undefined) next[q] = part[q];
          return next;
        });
      }
      setRef.current = apply;
      // 几何同步的 effect 只建一次（deps=[id]）→ 闭包里的 st 会一直停在挂载那一刻。
      // "有没有地址"要按最新值判（决定原生视图显不显示），所以走 ref。
      var urlRef = React.useRef(st.url);
      urlRef.current = st.url;
      // 原生视图**按需创建**：地址为空就根本不存在视图（不建、也就不需要藏）。
      // 2026-10-20 事故：空白标签也建视图、再按"有没有地址"藏/显，Electron 那边藏了再显会
      // 留在旧帧 → 屏幕上停着"藏之前截的占位图"（一张加载中的白页），而 Agent 在真实视图里照常操作。
      // ⇒ 视图的生死只跟"有没有地址"走，不做藏/显来回。
      var createdRef = React.useRef(false);

      // ① 视图生命期 + 壳事件订阅（每个浏览器标签一份；切标签会卸载本组件，但**不销毁**视图）
      React.useEffect(function () {
        if (!bridge) return;
        if (props.url) {
          try { bridge.create(id, props.url); createdRef.current = true } catch (e) {
            trace('ui', 'error', 'browser-create-failed', { id: id, error: String((e && e.message) || e) });
          }
        }
        // 视图可能早就建好了（切标签会卸载本组件，但**不销毁**视图）→ 问壳要一次当前状态，
        // 否则切回来地址栏是空的、前进/后退是灰的（壳只在"有变化"时才推送事件）。
        try {
          Promise.resolve(bridge.info(id)).then(function (r) {
            if (!r || !r.ok) return;
            setRef.current({
              url: r.url || '', title: r.title || '', canBack: !!r.canBack, canForward: !!r.canForward,
              loading: !!r.loading, fail: null,
              addr: editingRef.current ? undefined : (r.url || ''),
            });
            if (r.title && props.onTitle) props.onTitle(id, r.title);
          }).catch(function () { /* 忽略 */ });
        } catch (e) { /* 忽略 */ }
        // 幻影开关是**全局**的：新开的标签要跟壳里当前的值对齐，否则工具栏那颗按钮会显示成反的
        try {
          Promise.resolve(bridge.phantomState ? bridge.phantomState() : null).then(function (r) {
            if (r && r.ok) setRef.current({ phantomOn: !!r.on });
          }).catch(function () { /* 忽略 */ });
        } catch (e) { /* 忽略 */ }
        var off = bridge.onEvent(function (ev) {
          if (!ev) return;
          // 壳广播的"重排"（窗口缩放 / 跨显示器拖动 DPI 变化）：页面自己收不到，只能听壳的
          if (ev.type === 'relayout') { if (syncRef.current) syncRef.current(); return }
          if (ev.id !== id) return;
          var a = setRef.current;
          if (ev.type === 'title') { a({ title: ev.title || '' }); if (props.onTitle) props.onTitle(id, ev.title || ''); return }
          if (ev.type === 'nav' || ev.type === 'loading') {
            a({
              url: ev.url || '', title: ev.title || '', canBack: !!ev.canBack, canForward: !!ev.canForward,
              loading: !!ev.loading, fail: null,
              addr: editingRef.current ? undefined : (ev.url || ''),
            });
            if (ev.title && props.onTitle) props.onTitle(id, ev.title);
            return;
          }
          if (ev.type === 'fail') { a({ fail: ev.message || '页面加载失败', loading: false }); return }
          if (ev.type === 'placeholder') { a({ shot: ev.dataUrl || null }); return }
        });
        return function () {
          if (off) { try { off(); } catch (e) { /* 忽略 */ } }
          // 卸载只是"这个标签不显示了"（切走了/面板换了），**不销毁视图**：视图的存亡由标签的关闭决定
          if (createdRef.current) {
            try { bridge.setVisible(id, false); } catch (e) { /* 忽略 */ }
          }
          visibleRef.current = false;
        };
      }, [id]);

      // ② 几何 + 显隐：把矩形上报给壳，并在被浮层压住/面板藏起来时收起视图
      React.useEffect(function () {
        if (!bridge || !viewRef.current) return;
        var el = viewRef.current;
        var raf = 0;
        function rectOf() {
          var r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, width: r.width, height: r.height };
        }
        function sync() {
          raf = 0;
          try {
            var box = el.getBoundingClientRect();     // 判定用原始 DOMRect（left/right/top/bottom 都在）
            try { bridge.setBounds(id, rectOf()); } catch (e) { /* 忽略 */ }
            // 空白标签（还没输网址）不显示原生视图：它永远盖在 DOM 之上，一显示就会把
            // 界面自己的空白提示整块压住。没地址的视图本来没有内容可看 —— 而且这种标签
            // **连视图都不建**（见 createdRef），所以这里判 false 不会触发"藏→显"的来回。
            var want = !!urlRef.current && !rectOccluded(box);
            if (want && !createdRef.current && urlRef.current) {
              // 地址是刚有的（地址栏回车 / Agent 导航过来）→ 先把视图建出来，下面再显示它
              try { bridge.create(id, urlRef.current); createdRef.current = true } catch (e) {
                trace('ui', 'error', 'browser-create-failed', { id: id, error: String((e && e.message) || e) });
              }
            }
            if (want !== visibleRef.current) {
              visibleRef.current = want;
              trace('ui', 'info', 'browser-view', { id: id, visible: want, url: urlRef.current || '' });
              try {
                Promise.resolve(bridge.setVisible(id, want)).then(function (r) {
                  if (r && r.ok === false) {
                    trace('ui', 'error', 'browser-visible-failed', { id: id, visible: want, result: r });
                    return;
                  }
                  // 真显示出来了才撤占位图：那张图只该在"视图藏着"的时候顶班，
                  // 留着它一旦视图没画出来，用户看到的就是一张冻住的旧画面
                  if (want) setRef.current({ shot: null });
                }).catch(function (e) {
                  trace('ui', 'error', 'browser-visible-failed', { id: id, visible: want, error: String((e && e.message) || e) });
                });
              } catch (e) {
                trace('ui', 'error', 'browser-visible-failed', { id: id, visible: want, error: String((e && e.message) || e) });
              }
              // 视图收起来时把焦点交还页面，否则键盘还在那个看不见的视图里（VSCode 同样处理）
              if (!want) { try { bridge.blur(); } catch (e) { /* 忽略 */ } }
            }
          } catch (e) {
            // 这里炸掉的表现是"浏览器那块永远空白"（rAF 回调里的异常没人接）→ 必须留痕，别静默
            trace('ui', 'error', 'browser-sync-failed', { id: id, error: String((e && e.message) || e) });
          }
        }
        function schedule() { if (!raf) raf = requestAnimationFrame(sync); }
        var ro = null;
        try { ro = new ResizeObserver(schedule); ro.observe(el); } catch (e) { /* 老环境没有就算了 */ }
        window.addEventListener('resize', schedule);
        // 浮层是 React 现挂现卸的 → 盯 body 的增删与 style/class 变化，任何一次变化都重算一次。
        // ⚠ 不能用定时器轮询：§核心开发规则禁"用等待/延迟解决时序问题"，事件驱动才是正路。
        var mo = null;
        try {
          mo = new MutationObserver(schedule);
          mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
        } catch (e) { /* 忽略 */ }
        syncRef.current = schedule;
        schedule();
        return function () {
          if (raf) cancelAnimationFrame(raf);
          window.removeEventListener('resize', schedule);
          if (ro) { try { ro.disconnect(); } catch (e) { /* 忽略 */ } }
          if (mo) { try { mo.disconnect(); } catch (e) { /* 忽略 */ } }
          if (syncRef.current === schedule) syncRef.current = null;
        };
      }, [id]);

      // 地址从空变成有（地址栏回车）→ 原生视图该露出来了；上面那套同步只盯布局变化
      // （ResizeObserver / 窗口事件），state 变化它收不到，这一条是显隐的触发口。
      React.useEffect(function () {
        if (syncRef.current) syncRef.current();
      }, [st.url]);

      function act(action) {
        if (!bridge) return;
        try { bridge.action(id, action); } catch (e) { /* 忽略 */ }
      }
      function go() {
        var raw = (st.addr || '').trim();
        if (!bridge) return;
        editingRef.current = false;
        if (!raw) return;
        setRef.current({ fail: null });
        // 空白标签还没建视图（见 createdRef）→ 先建，否则 navigate 会落到"找不到页面"
        if (!createdRef.current) {
          try { bridge.create(id, raw); createdRef.current = true } catch (e) {
            trace('ui', 'error', 'browser-create-failed', { id: id, error: String((e && e.message) || e) });
          }
        }
        try { bridge.navigate(id, raw); } catch (e) { /* 忽略 */ }
      }

      if (!bridge) {
        return h('div', { className: 'dside-browser' },
          h('div', { className: 'dside-browser-empty' },
            h('div', { className: 'dside-browser-empty-big' }, '内置浏览器只在「天工」桌面版里可用'),
            h('div', { className: 'dside-browser-empty-sub' }, '当前是从浏览器打开的开发台（3080），没有原生浏览器视图。')),
        );
      }

      var bar = h('div', { className: 'dside-browser-bar' },
        h('button', { className: 'dside-browser-btn', title: '后退', disabled: !st.canBack, onClick: function () { act('back'); } }, '←'),
        h('button', { className: 'dside-browser-btn', title: '前进', disabled: !st.canForward, onClick: function () { act('forward'); } }, '→'),
        h('button', {
          className: 'dside-browser-btn',
          title: st.loading ? '停止加载' : '刷新 (F5)',
          onClick: function () { act(st.loading ? 'stop' : 'reload'); },
        }, st.loading ? '✕' : '⟳'),
        h('input', {
          className: 'dside-browser-url',
          ref: inputRef,
          spellCheck: false,
          placeholder: '输入网址后回车（例如 localhost:3000）',
          value: st.addr || '',
          onChange: function (e) { setRef.current({ addr: e.target.value }); },
          onFocus: function () { editingRef.current = true; },
          onBlur: function () { editingRef.current = false; setRef.current({ addr: st.url || '' }); },
          onKeyDown: function (e) {
            if (e.key === 'Enter') { e.preventDefault(); go(); }
            else if (e.key === 'Escape') { e.preventDefault(); setRef.current({ addr: st.url || '' }); try { e.target.blur(); } catch (err) { /* 忽略 */ } }
          },
        }),
        h('button', {
          className: 'dside-browser-btn', title: '在系统浏览器中打开',
          onClick: function () { if (st.url && bridge.openExternal) { try { bridge.openExternal(st.url); } catch (e) { /* 忽略 */ } } },
        }, '↗'),
        h('button', { className: 'dside-browser-btn', title: '开发者工具 (F12)', onClick: function () { act('devtools'); } }, '🛠'),
        // 幻影开关（设计定稿 §4.4）：**只在浏览器工具栏**，不进设置页。默认开；
        // 关掉只是"不演给人看"，Agent 的动作照做（幻影是可视化，不是闸门）。
        h('button', {
          className: 'dside-browser-btn' + (st.phantomOn ? ' on' : ''),
          title: st.phantomOn
            ? 'Agent幻影：开（Agent 操作时能看到指针与点击波纹）。点一下关掉——关掉后动作照样执行，只是不演'
            : 'Agent幻影：关（动作照做，但不显示指针与波纹）。点一下打开',
          onClick: function () {
            var next = !st.phantomOn;
            setRef.current({ phantomOn: next });
            try { bridge.setPhantom({ on: next }); } catch (e) { /* 忽略 */ }
            if (props.onStatus) props.onStatus('Agent幻影已' + (next ? '打开' : '关闭'));
          },
        }, st.phantomOn ? '👻' : '👻'),
      );

      var view = h('div', { className: 'dside-browser-view', ref: viewRef },
        st.shot ? h('img', { className: 'dside-browser-shot', src: st.shot, alt: '' }) : null,
        st.fail
          ? h('div', { className: 'dside-browser-empty' },
              h('div', { className: 'dside-browser-empty-big' }, '页面打不开'),
              h('div', { className: 'dside-browser-empty-sub' }, st.fail + (st.url ? '（' + st.url + '）' : '')))
          : null,
        // 空白标签的占位（照 VSCode 的 BrowserWelcomeFeature：不加载任何页面，界面自己铺字）。
        // 这时原生视图是藏着的，所以这几行真的看得见。
        (!st.url && !st.fail)
          ? h('div', { className: 'dside-browser-empty' },
              h('div', { className: 'dside-browser-empty-big' }, '内置浏览器'),
              h('div', { className: 'dside-browser-empty-sub' }, '在上方地址栏输入网址，回车打开'))
          : null,
      );

      return h('div', { className: 'dside-browser' }, bar, view);
    }

    // ── ⑥ 差异标签的正文（2026-10-10 重做，对齐 VSCode 的 "Open Changes in Diff Editor"）──
    // 左 = 改动前（拿磁盘内容把**没处理**的块倒推回去），右 = 现在（磁盘内容）。
    // 保留一块 → 该块退出"没处理"集合 → 左边那段变成新内容 → 差异当场消失（VSCode 的 Keep 语义）；
    // 撤销一块 → 真把这块还原到磁盘 → 两边一样 → 也消失。
    // ⚠ **必须定义在模块级**：定义在 Editor 内部时，父组件每次重渲染都会生成一个新的组件类型，
    //    React 会把整个视图卸载再重挂 —— 每次重挂都重新读文件，表现出来就是"这个视图一直在刷新"
    //    （2026-10-10 实测：6 秒内读了 9 次文件，还反复触发收尾）。组件定义位置 = 稳定性，别挪回组件内。
    // ⚠ 逐块按钮用 monaco 的 view zone 贴在块上方；跨组件只能走 props（见 §2 那条规矩）。
    function ReviewPane(rp) {
      var hostRef = React.useRef(null);
      var edRef = React.useRef(null);
      var modelsRefX = React.useRef([]);
      var widgetsRef = React.useRef([]);   // 块上的按钮（monaco content widget）
      var foundRef = React.useRef([]);
      var hookedRef = React.useRef(false);
      var rpRef = React.useRef(rp);
      rpRef.current = rp;
      var item = rp.item;
      var hunks = (item && item.hunks) ? item.hunks.filter(function (x) { return !x.status }) : [];
      var navState = React.useState({ found: 0, total: 0, idx: 0 });
      var nav = navState[0], setNav = navState[1];
      React.useEffect(function () {
        var mono = rp.getMonaco && rp.getMonaco();
        if (!item || !rp.ready || !mono || !hostRef.current) return;
        var alive = true;
        apiGet('/read-file', { path: item.path }).then(function (d) {
          if (!alive || !hostRef.current) return;
          if (!d || d.error || typeof d.content !== 'string') {
            if (rpRef.current.onStatus) rpRef.current.onStatus('读不到这个文件的内容：' + item.path);
            return;
          }
          var nowText = d.content;
          var oldText = nowText;
          var found = [];
          // 倒序把每块的"改后文本"换回"改前文本" → 得到"改动前那一版"
          for (var i = hunks.length - 1; i >= 0; i--) {
            var nt = hunks[i].after, ot = hunks[i].before || '';
            if (typeof nt !== 'string' || !nt) continue;
            var at = oldText.indexOf(nt);
            if (at < 0) continue;   // 磁盘上已经对不上（文件后来又被动过）：这块钱就不贴按钮
            found.push({ key: hunks[i].key, at: at });
            oldText = oldText.slice(0, at) + ot + oldText.slice(at + nt.length);
          }
          found.sort(function (a, b) { return a.at - b.at });   // 按位置排，才能跟差异区一一对上
          foundRef.current = found;
          setNav(function (p) { return { found: found.length, total: p.total, idx: p.idx } });
          var ed = edRef.current;
          if (!ed) {
            ed = mono.editor.createDiffEditor(hostRef.current, {
              readOnly: true, originalEditable: false, renderSideBySide: true,
              automaticLayout: true, renderOverviewRuler: false, scrollBeyondLastLine: false,
              minimap: { enabled: false }, glyphMargin: false,
            });
            edRef.current = ed;
            // 差异是异步算出来的：算完再贴按钮、并刷新"第几处/共几处"
            ed.onDidUpdateDiff(function () {
              applyWidgets(ed);
              var ch = ed.getLineChanges() || [];
              setNav(function (p) { return { found: p.found, total: ch.length, idx: Math.min(p.idx, Math.max(0, ch.length - 1)) } });
            });
          }
          // ⚠ 顺序不能变：先让 diff 编辑器松手（setModel(null)），再销毁旧 model，最后挂新的。
          //   反过来做 monaco 会报 "TextModel got disposed before DiffEditorWidget model got reset"（2026-10-10 实测）。
          var prev = modelsRefX.current;
          try { ed.setModel(null) } catch (e) { /* 忽略 */ }
          for (var q = 0; q < prev.length; q++) { try { prev[q].dispose() } catch (e) { /* 忽略 */ } }
          var om = mono.editor.createModel(oldText, undefined, mono.Uri.parse('inmemory://review/' + encodeURIComponent(item.changeKey) + '/original'));
          var nm = mono.editor.createModel(nowText, undefined, mono.Uri.parse('inmemory://review/' + encodeURIComponent(item.changeKey) + '/modified'));
          modelsRefX.current = [om, nm];
          ed.setModel({ original: om, modified: nm });
          // 光标一动就更新"第几处"（VSCode 的 chat 改动工具条也是跟着光标走的）
          if (!hookedRef.current) {
            hookedRef.current = true;
            try { ed.getModifiedEditor().onDidChangeCursorPosition(function () { syncIdx() }) } catch (e) { /* 忽略 */ }
          }
        });
        return function () { alive = false };
      }, [item ? item.changeKey : '', hunks.length, rp.ready, rp.rev]);
      function changesOf() {
        var ed = edRef.current;
        return (ed && ed.getLineChanges()) || [];
      }
      function curIdx() {
        var ed = edRef.current;
        if (!ed) return 0;
        var ch = changesOf();
        if (!ch.length) return 0;
        var me = ed.getModifiedEditor();
        var ln = (me && me.getPosition()) ? me.getPosition().lineNumber : 1;
        var cur = 0;
        for (var i = 0; i < ch.length; i++) { if (ch[i].modifiedStartLineNumber <= ln) cur = i; else break; }
        return cur;
      }
      function syncIdx() {
        var ch = changesOf();
        setNav(function (p) { return { found: p.found, total: ch.length, idx: curIdx() } });
      }
      // 上一处 / 下一处：对齐 VSCode 的 chat 改动导航（Alt+Shift+F5 / Alt+F5），到头回绕
      function step(d) {
        var ed = edRef.current;
        if (!ed) return;
        var ch = changesOf();
        if (!ch.length) return;
        var next = (curIdx() + d + ch.length) % ch.length;
        try {
          var me = ed.getModifiedEditor();
          me.revealLineInCenter(ch[next].modifiedStartLineNumber);
          me.setPosition({ lineNumber: ch[next].modifiedStartLineNumber, column: 1 });
          me.focus();
        } catch (e) { /* 拿不到编辑器就只当没跳 */ }
        setNav(function (p) { return { found: p.found, total: ch.length, idx: next } });
      }
      // 把 step 挂到模块级指针上，供键位（Alt+Shift+F5 / Alt+F5）调用；卸载时先比一句再清，
      // 免得"后挂的先卸"把当前这一份抹掉。每次渲染后刷新（step 闭包要拿到最新的 ch/nav）。
      React.useEffect(function () {
        REVIEW_STEP.fn = step;
        return function () { if (REVIEW_STEP.fn === step) REVIEW_STEP.fn = null; };
      });
      // 逐块按钮挂在 monaco 的 **content widget** 层，不用 view zone。
      // ⚠ view zone 的 DOM 在文本层**下面**，真人鼠标点下去命中的是 `view-lines`（被吃掉）——
      //    而程序化 `element.click()` 不走命中测试、照样成功，所以只看探针会误判"按钮好使"
      //    （2026-10-10 实测：命中元素 = DIV.view-lines.monaco-mouse-cursor-text）。VSCode 的 diff 块按钮也是 content widget。
      function applyWidgets(ed) {
        var found = foundRef.current;
        var me = ed.getModifiedEditor();
        var changes = ed.getLineChanges() || [];
        for (var w = 0; w < widgetsRef.current.length; w++) {
          try { me.removeContentWidget(widgetsRef.current[w]) } catch (e) { /* 忽略 */ }
        }
        widgetsRef.current = [];
        // 块与差异区一一对应才贴按钮；对不上就只给整体差异，绝不乱贴
        if (found.length !== changes.length) return;
        var mono = rp.getMonaco && rp.getMonaco();
        var Pref = mono ? mono.editor.ContentWidgetPositionPreference : null;
        for (var c = 0; c < changes.length; c++) {
          (function (change, hunk, idx) {
            var widget = {
              getId: function () { return 'dside-hunk-w' + idx },
              getDomNode: function () { return makeDom(hunk) },
              getPosition: function () {
                return {
                  position: { lineNumber: Math.max(1, change.modifiedStartLineNumber), column: 1 },
                  preference: Pref ? [Pref.ABOVE] : undefined,
                };
              },
            };
            widgetsRef.current.push(widget);
            me.addContentWidget(widget);
          })(changes[c], found[c], c);
        }
      }
      function makeDom(hunk) {
        var dom = document.createElement('div');
        dom.className = 'dside-hunk-acts';
        var b1 = document.createElement('button');
        b1.className = 'dside-btn small';
        b1.textContent = '保留';
        b1.title = '保留这一处（其余不动）';
        b1.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (rpRef.current.onKeepHunk) rpRef.current.onKeepHunk(item.changeKey, hunk.key) });
        var b2 = document.createElement('button');
        b2.className = 'dside-btn small danger';
        b2.textContent = '撤销';
        b2.title = '只把这一处还原回去';
        b2.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (rpRef.current.onUndoHunk) rpRef.current.onUndoHunk(item.changeKey, hunk.key) });
        dom.appendChild(b1);
        dom.appendChild(b2);
        return dom;
      }
      React.useEffect(function () {
        return function () {
          try { if (edRef.current) edRef.current.dispose() } catch (e) { /* 忽略 */ }
          edRef.current = null;
          for (var q = 0; q < modelsRefX.current.length; q++) { try { modelsRefX.current[q].dispose() } catch (e) { /* 忽略 */ } }
          modelsRefX.current = [];
        };
      }, []);
      var staleCount = hunks.length - nav.found;
      return h('div', { className: 'dside-review' },
        h('div', { className: 'dside-review-head' },
          h('b', null, item ? item.name : '没有可审阅的改动'),
          h('span', { className: 'hint' },
            hunks.length
              ? ('还有 ' + hunks.length + ' 处没处理' + (staleCount > 0 ? '（其中 ' + staleCount + ' 处已经在文件里找不到了，点「保留这个文件」收尾）' : ''))
              : '都处理完了'),
          h('span', { className: 'sp' }),
          h('button', {
            className: 'dside-btn small primary',
            title: '保留这个文件的全部改动',
            onClick: function () { if (rpRef.current.onKeepFile) rpRef.current.onKeepFile(rpRef.current.changeKey) },
          }, '保留这个文件'),
          h('button', {
            className: 'dside-btn small danger',
            title: '把这个文件的改动全部还原回去',
            onClick: function () { if (rpRef.current.onRollbackFile && item) rpRef.current.onRollbackFile(item.path) },
          }, '撤销这个文件'),
          h('button', { className: 'dside-btn small', onClick: function () { if (rpRef.current.onClose) rpRef.current.onClose() } }, '关闭'),
        ),
        h('div', { className: 'dside-review-body', ref: hostRef }),
        nav.total
          ? h('div', { className: 'dside-review-nav' },
              h('span', { className: 'cnt' }, (nav.idx + 1) + ' / ' + nav.total),
              h('button', { className: 'dside-btn small', title: '上一处改动（Alt+Shift+F5）', onClick: function () { step(-1) } }, '↑'),
              h('button', { className: 'dside-btn small', title: '下一处改动（Alt+F5）', onClick: function () { step(1) } }, '↓'),
            )
          : null,
      );
    }

    function Editor(props) {
      var file = props.file, refreshTick = props.refreshTick, status = props.status, themeMode = props.themeMode;
      var tabs = props.tabs || [], activePath = props.activePath;
      var hostRef = React.useRef(null);
      var editorRef = React.useRef(null);
      var modelRef = React.useRef(null);
      var subRef = React.useRef(null);
      var modelsRef = React.useRef({});   // path -> { model, saved }（切文件保留未保存编辑）
      var dragTabRef = React.useRef(null); // ⑫ A4 正在拖拽的标签路径（HTML5 DnD 不给读 dataTransfer 的场景兜底）
      var inlineProvRef = React.useRef(null); // ⑭-② 内联建议 provider（全局注册一次）
      var monacoRef = React.useRef(null);
      var fileRef = React.useRef(null);
      var savingRef = React.useRef(false);
      var themeModeRef = React.useRef('dark');
      var tickRef = React.useRef({});     // path -> 已处理的 refreshTick（⟳ 强制回读磁盘）
      var lastTracedFileRef = React.useRef('');
      var modelPathRef = React.useRef(null);   // 当前显示 model 对应 path（③ 跳转判定）
      var pendingGotoRef = React.useRef(null); // ③ 定位意图：模型未挂好时暂存，attachModel 后消费
      var askOpenRef = React.useRef(null);     // ⑥ 问 Agent 入口（makeEditor 只跑一次 → 回调走 ref 防 stale closure）
      var keyActsRef = React.useRef({});       // 键位注册表登记的编辑器动作（id → monaco 的 disposable）
      var propsRef = React.useRef(props);      // 定时器/异步回调里取最新 props（防 stale closure，踩坑 22）
      var extRef = React.useRef({});           // path -> 外部改动状态（⑥ 提示条 / 差异审阅的数据源）
      var diffHostRef = React.useRef(null);    // diff 编辑器专用叶子容器（踩坑 17：不能有 React 子节点）
      var diffEdRef = React.useRef(null);
      var diffSeqRef = React.useRef(0);
      fileRef.current = file;
      themeModeRef.current = themeMode === 'dark' ? 'dark' : 'light';
      propsRef.current = props;

      var loadStateState = React.useState('loading'); // loading | ready | error
      var loadState = loadStateState[0], setLoadState = loadStateState[1];
      var errorState = React.useState(null);
      var error = errorState[0], setError = errorState[1];
      var dirtyState = React.useState(false);
      var dirty = dirtyState[0], setDirty = dirtyState[1];
      var savingState = React.useState(false);
      var saving = savingState[0], setSaving = savingState[1];
      var loadingFileState = React.useState(false);
      var loadingFile = loadingFileState[0], setLoadingFile = loadingFileState[1];
      var extTickState = React.useState(0);    // 外部改动状态变更 → 自增触发重渲染
      var bumpExt = extTickState[1];
      var diffStateState = React.useState(null);
      var diffState = diffStateState[0], setDiff = diffStateState[1];

      // ── 媒体预览 / 二进制占位卡的状态（2026-09-23）────────────────────────
      // mediaKind：按扩展名判定这个文件该走预览器（图片/音频/视频）而不是文本编辑器
      var mediaKind = file ? mediaKindOf(file.name) : null;
      // SVG 的"以文本打开"（VSCode 只对 .svg 提供 reopenAsText / reopenAsPreview 来回切）；
      // 记在 path 上：切标签再回来仍保持用户的选择（与 VSCode 的编辑器选择同语义）
      var asTextState = React.useState({});
      var asTextMap = asTextState[0], setAsTextMap = asTextState[1];
      var svgAsText = !!(file && isSvgName(file.name) && asTextMap[file.path]);
      var effMedia = mediaKind && !svgAsText ? mediaKind : null;
      // 文本读不出来（平台 FS_NOT_TEXT）= VSCode 那个 Binary Viewer 占位卡，不是错误
      var binaryState = React.useState(null);
      var binary = binaryState[0], setBinary = binaryState[1];
      var mediaApiRef = React.useRef(null);   // 把图片缩放暴露给命令面板（VSCode 有 zoomIn/zoomOut 命令）

      function setSvgAsText(path, on) {
        setAsTextMap(function (prev) {
          var next = {};
          for (var k in prev) if (k !== path) next[k] = prev[k];
          if (on) next[path] = true;
          return next;
        });
      }

      function attachModel(model, rec, path) {
        var editor = editorRef.current;
        if (!editor) return;
        if (subRef.current) { subRef.current.dispose(); subRef.current = null; }
        subRef.current = model.onDidChangeContent(function () {
          var d = model.getValue() !== rec.saved;
          setDirty(d);
          if (props.onDirtyChange) props.onDirtyChange(path, d);
        });
        editor.setModel(model);
        // 语言级默认跟着模型走：md 自动换行、txt/代码不换行（切标签、切语言都要重算）
        try { editor.updateOptions(langEditorOptions(model.getLanguageId())); } catch (e) { /* 老版本 monaco 忽略 */ }
        modelRef.current = model;
        modelPathRef.current = path;
        // 会话恢复：这个标签关软件时是脏的 → 把本机存的草稿重新套回缓冲区（内容仍算"未保存"）。
        // 放在这里（而不是读盘那一步）：切标签走缓存分支时也要能套上。
        if (hasPendingDraft(path)) {
          var dr = takePendingDraft(path);
          clearPendingDraftRoot(path);
          var draft = dr ? dr.text : null;
          if (draft !== null && draft !== model.getValue()) {
            var keepPos = null;
            try { keepPos = editor.getPosition(); } catch (e) { keepPos = null; }
            // ⚠ hot exit 的版本守卫（对齐 VSCode）：先记下"刚读到的磁盘版本"，再套草稿
            var diskVersion = rec ? (rec.baseVersion ? String(rec.baseVersion) : null) : null;
            var diskText = rec ? rec.saved : '';
            model.setValue(draft);
            try { if (keepPos && editor.getModel() === model) editor.setPosition(keepPos); } catch (e) { /* 忽略 */ }
            // 明确把"这个标签是脏的"报上去：模型 setValue 触发的 onDidChangeContent 在
            // 恢复这条时序里可能赶在 tabs 列表落定之前（2026-09-22 实测窗口期）—— 脏标必须由
            // 这里兜一道，否则用户看到的是"内容回来了、但标签显示已保存"。
            try { props.onDirtyChange(path, true); } catch (e) { /* 忽略 */ }
            trace('ui', 'info', 'draft-restored', { path: path, chars: draft.length, hasBase: !!dr.base });
            // 草稿的基准版本 ≠ 现在磁盘上的版本 = **你关软件期间这个文件被改过**（Agent、别的编辑器、
            // 另一台机器…）→ 把保存基准退回草稿那一版：保存会被平台按版本令牌拦下，走既有的
            // "磁盘已更改"冲突条（用我的版本覆盖 / 采用磁盘版 / 看差异），绝不静默盖掉别人的改动。
            if (dr.base && diskVersion !== null && String(dr.base) !== diskVersion && rec) {
              rec.baseVersion = String(dr.base);
              setExt(path, {
                kind: 'conflict',
                leftText: draft,
                rightText: typeof diskText === 'string' ? diskText : '',
                diskVersion: diskVersion,
                at: Date.now(),
              });
              if (props.status) props.status('这个文件在你关软件期间被改过：保存时会先让你选（覆盖 / 采用磁盘版）');
              trace('ui', 'warn', 'draft-restore-conflict', { path: path, base: dr.base, disk: diskVersion });
            }
          }
        }
        setDirty(model.getValue() !== rec.saved);
        // ③ 消费跳转意图（读盘完成/缓存 attach 后才可能有视图，踩坑 17）
        var pend = pendingGotoRef.current;
        if (pend && pend.path === path) doReveal(pend);
      }

      function save() {
        var f = fileRef.current;
        var editor = editorRef.current;
        var model = modelRef.current;
        if (!f || !editor || !model || savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        var content = model.getValue();
        var rec0 = modelsRef.current[f.path];
        // ⑥ 带上读到的磁盘版本：磁盘被别人改过时平台会拒绝（绝不用旧内容静默盖掉 Agent 的改动）
        var baseVersion = rec0 && rec0.baseVersion ? rec0.baseVersion : undefined;
        apiPost('/write-file', { path: f.path, content: content, baseVersion: baseVersion }).then(function (r) {
          savingRef.current = false;
          setSaving(false);
          if (r && r.code === 'stale-version') { onSaveConflict(f.path, content); return; }
          if (r && r.error) {
            setError(r.error);
            trace('ui', 'error', 'save-failed', { path: f.path, error: String(r.error) });
            return;
          }
          markSaved(f.path, content, r && r.version);
          setDirty(false);
          if (props.onDirtyChange) props.onDirtyChange(f.path, false);
          status('已保存: ' + f.path);
          trace('ui', 'info', 'save-ok', { path: f.path, bytes: content.length });
          snapAuto('保存后');        // 反悔药：每次保存成功后留一个还原点（host 侧内容没变则不落新快照）
        }).catch(function (e) {
          savingRef.current = false;
          setSaving(false);
          setError(String((e && e.message) || e));
          trace('ui', 'error', 'save-failed', { path: f.path, error: String((e && e.message) || e) });
        });
      }

      // 关闭 tab 时由上层调用：dispose 对应 monaco model（释放内存）。
      // 若关的是当前显示的文件，先把编辑器模型摘掉，等新 active 由 effect 挂上。
      function disposeModel(path) {
        var rec = modelsRef.current[path];
        if (!rec) return;
        if (subRef.current && modelRef.current === rec.model) {
          subRef.current.dispose();
          subRef.current = null;
          modelRef.current = null;
          modelPathRef.current = null;
          if (editorRef.current) editorRef.current.setModel(null);
        }
        try { rec.model.dispose(); } catch (e) { /* 已释放 */ }
        delete modelsRef.current[path];
        delete tickRef.current[path];
        if (extRef.current[path]) setExt(path, null);
      }

      // ③ 定位跳转：monaco 视图要等 setModel 后才存在（踩坑 17），
      // 延迟一帧再 reveal，等布局完成
      function doReveal(req) {
        pendingGotoRef.current = null;
        setTimeout(function () {
          var editor = editorRef.current;
          if (!editor) return;
          var line = Math.max(1, (req.line | 0) || 1);
          var col = Math.max(1, (req.col | 0) || 1);
          // ⑤ 转到定义：目标文件是"这次才打开"的，父层此刻拿不到行列，只带 worker 给的
          // 字符偏移 —— 模型挂好之后在这里换算（monaco 的 Position 与 TS 的 offset 同源）
          if (req.offset !== undefined && req.offset !== null && modelRef.current) {
            try {
              var pAt = modelRef.current.getPositionAt(Math.max(0, req.offset | 0));
              line = pAt.lineNumber;
              col = pAt.column;
            } catch (e) { /* 换算失败就用兜底行列 */ }
          }
          try {
            editor.revealPositionInCenter({ lineNumber: line, column: col });
            editor.setPosition({ lineNumber: line, column: col });
            editor.focus();
          } catch (e) { /* 忽略 */ }
        }, 80);
      }

      // ③ 全部保存（命令面板：脏 model 逐个写盘）
      function saveAll() {
        var paths = Object.keys(modelsRef.current);
        var dirtyList = [];
        for (var i = 0; i < paths.length; i++) {
          var p = paths[i];
          var rec = modelsRef.current[p];
          if (rec && rec.model && rec.model.getValue() !== rec.saved) dirtyList.push({ path: p, model: rec.model });
        }
        if (!dirtyList.length) {
          if (props.status) props.status('没有未保存的更改');
          return;
        }
        var done = 0;
        var firstErr = null;
        var chain = Promise.resolve();
        for (var j = 0; j < dirtyList.length; j++) {
          (function (d) {
            chain = chain.then(function () {
              var rec3 = modelsRef.current[d.path];
              return apiPost('/write-file', {
                path: d.path,
                content: d.model.getValue(),
                baseVersion: rec3 && rec3.baseVersion ? rec3.baseVersion : undefined,
              }).then(function (r) {
                if (r && r.code === 'stale-version') {
                  firstErr = firstErr || ('磁盘已更改，未覆盖: ' + d.path);
                  onSaveConflict(d.path, d.model.getValue());
                  return;
                }
                if (r && r.error) { firstErr = firstErr || r.error; return; }
                markSaved(d.path, d.model.getValue(), r && r.version);
                if (props.onDirtyChange) props.onDirtyChange(d.path, false);
                done += 1;
              });
            });
          })(dirtyList[j]);
        }
        chain.then(function () {
          if (firstErr) {
            if (props.status) props.status('全部保存失败: ' + firstErr);
            trace('ui', 'error', 'save-all-failed', { error: String(firstErr) });
          } else {
            if (props.status) props.status('已全部保存 (' + done + ' 个文件)');
            trace('ui', 'info', 'save-all-ok', { count: done });
          }
        }).catch(function (e) {
          if (props.status) props.status('全部保存失败: ' + String((e && e.message) || e));
        });
      }

      // ── ⑥ 外部改动侦测 / 差异审阅 / 接受·回滚（单文件闭环）──────────────
      // 背景：Agent 改文件、外部编辑器、git checkout 都会让磁盘领先于编辑器里缓存的
      // model（§3 按 path 缓存）。以前只有手动 ⟳ 能回读，而脏 model 一保存就把别人
      // 的改动静默盖掉（数据丢失）。现在：轮询磁盘版本令牌 → 内容真变了才提示 →
      // monaco diff 审阅 → 接受 / 覆盖；保存一律带版本令牌（平台 replaceIfVersion 兜底）。
      function setExt(path, info) {
        if (info) extRef.current[path] = info; else delete extRef.current[path];
        bumpExt(function (n) { return n + 1; });
      }

      // 写盘成功 / 回读磁盘后同步"编辑器已知的磁盘版本"，并留一小段静默窗口，
      // 免得在飞行中的轮询把这次已知变更再报一次（假警报）
      function markSaved(path, content, version) {
        var rec = modelsRef.current[path];
        if (!rec) return;
        rec.saved = content;
        rec.baseVersion = version ? String(version) : null;
        rec.ignoreUntil = Date.now() + 1200;
      }

      // 用磁盘内容替换编辑器内容（=「采用磁盘版」）：清脏标、更新版本令牌
      function applyDiskToModel(path, text, version) {
        var rec = modelsRef.current[path];
        if (!rec) return;
        rec.ignoreUntil = Date.now() + 1200;
        rec.model.setValue(text);
        rec.saved = text;
        rec.baseVersion = version ? String(version) : null;
        if (modelPathRef.current === path) setDirty(false);
        if (propsRef.current.onDirtyChange) propsRef.current.onDirtyChange(path, false);
      }

      // 保存被平台拒绝（磁盘已变）→ 取磁盘内容，弹冲突条 + 可看差异
      function onSaveConflict(path, myText) {
        apiGet('/read-file', { path: path }).then(function (d) {
          var rec = modelsRef.current[path];
          if (d && !d.error && typeof d.content === 'string') {
            setExt(path, {
              kind: 'conflict',
              leftText: myText !== undefined ? myText : (rec ? rec.model.getValue() : ''),
              rightText: d.content,
              diskVersion: d.version ? String(d.version) : null,
              at: Date.now(),
            });
          } else {
            setExt(path, { kind: 'missing', at: Date.now() });
          }
          if (propsRef.current.status) propsRef.current.status('磁盘上的文件已更改，保存被拦下（未覆盖）: ' + path);
          trace('ui', 'warn', 'save-blocked-stale', { path: path });
        });
      }

      // ── VSCode 二进制占位卡上的「Open Anyway」＝ force=1 强制按文本读 ────────────
      // 与 VSCode 的 allowBinary: ForceOpenAs.Text 同语义：无效字节解码成 U+FFFD，照样可编辑可保存。
      // ⚠ 保存会把这份"文本"按 UTF-8 写回 —— 与 VSCode 一样是用户自己的明确选择（占位卡上的按钮）。
      function forceOpenAsText() {
        var f = fileRef.current;
        var monaco = monacoRef.current;
        if (!f || !monaco) return;
        trace('ui', 'warn', 'open-anyway', { path: f.path });
        apiGet('/read-file', { path: f.path, force: 1 }).then(function (r) {
          if (!r || r.error || typeof r.content !== 'string') {
            setError((r && r.error) || '读不出来');
            return;
          }
          var cache = modelsRef.current;
          var rec = cache[f.path];
          var model;
          if (rec) {
            model = rec.model;
            model.setValue(r.content);
          } else {
            model = monaco.editor.createModel(
              r.content,
              languageFor(monaco, f.name),
              monaco.Uri.parse('file:///' + f.path.replace(/\\/g, '/')),
            );
            rec = { model: model, saved: '', baseVersion: null };
            cache[f.path] = rec;
          }
          rec.saved = r.content;
          rec.baseVersion = r.version ? String(r.version) : null;
          rec.ignoreUntil = Date.now() + 500;
          tickRef.current[f.path] = refreshTick;
          setBinary(null);
          setError(null);
          attachModel(model, rec, f.path);
          if (propsRef.current.status) propsRef.current.status('已按文本打开（保存会按文本写回，谨慎保存）: ' + f.path);
        });
      }

      // 用户在冲突条上明确选择「用我的版本覆盖磁盘」
      function forceSave(path) {
        var rec = modelsRef.current[path];
        if (!rec) return;
        var content = rec.model.getValue();
        apiPost('/write-file', { path: path, content: content, force: true }).then(function (r) {
          if (r && r.error) { setError(r.error); return; }
          markSaved(path, content, r && r.version);
          if (modelPathRef.current === path) setDirty(false);
          if (propsRef.current.onDirtyChange) propsRef.current.onDirtyChange(path, false);
          setExt(path, null);
          if (propsRef.current.status) propsRef.current.status('已用编辑器内容覆盖磁盘: ' + path);
          trace('ui', 'warn', 'ext-overwrite-disk', { path: path });
        });
      }

      // 接受磁盘版（差异浮层里的主按钮 / 提示条按钮）
      function acceptDiskVersion(path) {
        var info = extRef.current[path];
        if (!info || typeof info.rightText !== 'string') { setExt(path, null); return; }
        applyDiskToModel(path, info.rightText, info.diskVersion);
        setExt(path, null);
        if (propsRef.current.status) propsRef.current.status('已采用磁盘版本: ' + path);
        trace('ui', 'info', 'ext-accept-disk', { path: path });
      }

      function openDiff(path, leftTitle, leftText, rightTitle, rightText, kind, canUndo) {
        diffSeqRef.current += 1;
        setDiff({
          seq: diffSeqRef.current, path: path, kind: kind,
          leftTitle: leftTitle, leftText: leftText,
          rightTitle: rightTitle, rightText: rightText,
          canUndo: canUndo === true,
        });
      }

      // ── ⑥ 第三刀：多文件审阅队列（一次审多个文件：chips 切换 + 上一个/下一个）──
      // 换文件 = 新起一个 seq → 复用「seq 变了就重建 diff 编辑器」的同一套 effect（只读、无脏数据）
      // ⑥ 第四刀：逐块审阅。块状态**由改动清单那侧算好、随 items 一起递进来**（it.hunks[].status）。
      // ⚠ 别在这一层查状态表：状态表（changeStatusRef）属于改动清单组件，这里够不着，
      // 读它直接 ReferenceError —— 而本函数在 root 槽的渲染路径上，抛一次整个界面白屏
      // （2026-10-10 实测：点改动行必崩）。以后要加新状态，一律在改动清单侧算好再放进 items。
      function hunksWithStatus(it) {
        var out = [], i;
        for (i = 0; i < it.hunks.length; i++) {
          var h = it.hunks[i];
          out.push({ key: h.key, before: h.before, after: h.after, status: h.status || '' });
        }
        return out;
      }
      // 这两件事只跟"浮层自己的 diff 编辑器"有关，必须定义在本组件作用域内。
      // ⚠ 2026-10-10 教训：它们原来写在内层组件里，这里够不着 —— hunkLines 在**渲染期**被调用，
      // 一抛就是 root 槽崩、整个界面白屏。凡是浮层渲染/交互用到的函数，一律留在本层；
      // 需要内层数据（块状态表）的，只能靠 props 递进来的回调（见 onHunkKeep / onHunkUndo）。
      function hunkLines(text) {
        if (typeof text !== 'string' || !text) return 0;
        return text.split('\n').length;
      }
      function gotoHunkLine(line) {
        var e = (diffEdRef && diffEdRef.current && diffEdRef.current.editor) || null;
        if (!e || !e.getModifiedEditor) return;
        try {
          var me = e.getModifiedEditor();
          if (me && me.revealLineInCenter) me.revealLineInCenter(Math.max(1, line));
        } catch (err) { /* 内层编辑器拿不到就只当没跳，别把浮层弄崩 */ }
      }
      // 已撤销的块：右侧也显示成"改之前"的样子 → 左右对比天然显示"这块已经没有差异了"
      // （锚点 note：右侧文本是这里现算的，不是磁盘内容；撤销一块之后必须重走这里才看得见变化）
      function hunksTextsOf(hk) {
        var bs = [], as = [], i;
        for (i = 0; i < hk.length; i++) {
          bs.push(hk[i].before);
          as.push(hk[i].status === 'undone' ? hk[i].before : hk[i].after);
        }
        return { leftText: bs.join('\n⋯\n'), rightText: as.join('\n⋯\n') };
      }

      function diffStateAt(d, idx, undone) {
        var it = d.items[idx];
        if (!it) return d;
        diffSeqRef.current += 1;
        var hks = it.hunks ? hunksWithStatus(it) : null;
        var tx = hks ? hunksTextsOf(hks) : null;
        return {
          // 快照差异复用同一套浮层：kind='snapshot' 时头部换成"还原"那套按钮与文案
          seq: diffSeqRef.current, kind: d.snapTs ? 'snapshot' : 'review', canUndo: d.canUndo !== false,
          path: it.path, leftTitle: it.leftTitle, leftText: tx ? tx.leftText : it.leftText,
          rightTitle: it.rightTitle, rightText: tx ? tx.rightText : it.rightText,
          hunks: hks, changeKey: it.changeKey || '',
          // 带上审阅状态，浮层头部才能标出「已保留 / 已撤销」
          status: it.status || '', turn: it.turn || '', isCreate: !!it.isCreate,
          snapTs: d.snapTs || 0, snapLabel: d.snapLabel || '', snapStatus: it.snapStatus || '',
          items: d.items, index: idx, undone: undone || d.undone || {},
        };
      }

      function openReview(items, index, extra) {
        var list = (items || []).slice();
        if (!list.length) return;
        var i = Math.max(0, Math.min(list.length - 1, index || 0));
        setDiff(diffStateAt({
          items: list, undone: {},
          canUndo: !(extra && extra.canUndo === false),
          snapTs: extra && extra.snapTs, snapLabel: extra && extra.snapLabel,
        }, i));
      }

      function gotoReviewItem(idx) {
        setDiff(function (d) {
          if (!d || !d.items) return d;
          var i = Math.max(0, Math.min(d.items.length - 1, idx));
          if (i === d.index) return d;
          trace('ui', 'info', 'change-review-nav', { path: d.items[i].path, index: i });
          return diffStateAt(d, i);
        });
      }

      // 队列内撤销当前文件：本地登记 undone → 交给面板真正动手 → 自动跳到下一个未撤销的文件
      function undoReviewItem() {
        var d = diffState;
        if (!d) return;
        var undone = {};
        for (var k in (d.undone || {})) undone[k] = true;
        undone[d.path] = true;
        trace('ui', 'warn', 'change-review-undo', { path: d.path, queued: !!(d.items && d.items.length > 1) });
        if (propsRef.current.onRollbackChange) propsRef.current.onRollbackChange(d.path);
        if (d.items && d.items.length > 1) {
          var next = -1, i;
          for (i = d.index + 1; i < d.items.length; i++) { if (!undone[d.items[i].path]) { next = i; break; } }
          if (next < 0) for (i = 0; i < d.index; i++) { if (!undone[d.items[i].path]) { next = i; break; } }
          setDiff(diffStateAt(d, next >= 0 ? next : d.index, undone));
          return;
        }
        setDiff(null);
      }

      // 轮询：只探版本令牌（不回内容）；令牌变了再拉内容做"内容级"判定，
      // 避免 touch / 无关元数据变化造成假警报
      function checkOneExternal(path) {
        var rec = modelsRef.current[path];
        if (!rec || !rec.baseVersion || rec.busy) return;
        if (rec.ignoreUntil && Date.now() < rec.ignoreUntil) return;
        rec.busy = true;
        apiGet('/stat', { path: path }).then(function (st) {
          var r = modelsRef.current[path];
          if (r) r.busy = false;
          if (!r || !st || st.error) return;
          if (st.exists === false) {
            r.baseVersion = null;
            if (!extRef.current[path]) {
              setExt(path, { kind: 'missing', at: Date.now() });
              trace('ui', 'warn', 'ext-file-missing', { path: path });
            }
            return;
          }
          if (!st.version || String(st.version) === String(r.baseVersion)) return;
          return apiGet('/read-file', { path: path }).then(function (d) {
            var r2 = modelsRef.current[path];
            if (!r2 || !d || d.error || typeof d.content !== 'string') return;
            if (d.content === r2.saved) { r2.baseVersion = d.version ? String(d.version) : null; return; }
            var dirtyNow = r2.model.getValue() !== r2.saved;
            if (!dirtyNow) {
              // VSCode 手感：干净缓冲区被外部改动 → 静默跟随磁盘（不留陈旧内容），
              // 再给一条"可查看差异"的提示条（这就是 Agent 改动可审阅的入口）
              var oldText = r2.saved;
              applyDiskToModel(path, d.content, d.version);
              setExt(path, {
                kind: 'reloaded', oldText: oldText, rightText: d.content,
                diskVersion: d.version ? String(d.version) : null, at: Date.now(),
              });
              trace('ui', 'info', 'ext-change-reloaded', { path: path });
            } else {
              setExt(path, {
                kind: 'conflict',
                leftText: r2.model.getValue(), rightText: d.content,
                diskVersion: d.version ? String(d.version) : null, at: Date.now(),
              });
              trace('ui', 'warn', 'ext-change-conflict', { path: path });
            }
          });
        }).catch(function () {
          var r3 = modelsRef.current[path];
          if (r3) r3.busy = false;
        });
      }

      function checkExternal() {
        try { if (document.hidden) return; } catch (e) { /* 非浏览器环境 */ }
        var paths = Object.keys(modelsRef.current);
        for (var i = 0; i < paths.length; i++) checkOneExternal(paths[i]);
      }

      // 把 disposeModel/save/saveAll 暴露给上层（IdeApp 的命令面板调用）
      React.useEffect(function () {
        if (props.editorBridge) props.editorBridge.current = {
          disposeModel: disposeModel,
          save: save,
          saveAll: saveAll,
          runAction: runEditorAction,   // ⑤ 给命令面板调用 monaco 动作（大纲/重命名/格式化/悬停/标记跳转）
          gotoDefinition: gotoDefinition,
          scanProjectProblems: scanProjectProblems,   // ⑤ 项目级全量诊断（问题面板用）
          // 「设置」组里的编辑器字号（− / ＋ 实时生效；偏好落 localStorage）
          setFontSize: function (px) {
            var ed = editorRef.current;
            if (ed) ed.updateOptions({ fontSize: px });
          },
          // 【编辑器设置】页改一项 → 立刻套到当前编辑器上（存盘由设置页负责）
          applyEditorPrefs: function (opts) {
            var ed = editorRef.current;
            if (ed && opts) ed.updateOptions(opts);
          },
          // 图片预览的缩放（命令面板的两条命令；VSCode 里是 imagePreview.zoomIn / zoomOut）
          mediaZoom: function (dir) {
            var a = mediaApiRef.current;
            if (!a) { if (propsRef.current.status) propsRef.current.status('当前打开的不是图片（没有可缩放的内容）'); return }
            if (dir > 0) a.zoomIn(); else if (dir < 0) a.zoomOut(); else a.fit();
          },
        };
        // 会话恢复要用"脏缓冲区正文 + 它的基准磁盘版本"：把这份能力交给上层（落盘时按需调用）。
        // base 就是 VSCode hot exit 的版本守卫依据（见 attachModel 里套草稿那一段）。
        if (props.draftGetterRef) {
          props.draftGetterRef.current = function (path) {
            var r = modelsRef.current[path];
            if (!r || !r.model) return null;
            return { text: r.model.getValue(), base: r.baseVersion ? String(r.baseVersion) : null };
          };
        }
      }, []);

      // ⑤ 工作空间根确定且 monaco 就绪后，喂一次项目文件（同一个根只喂一次）
      React.useEffect(function () {
        if (loadState !== 'ready' || !props.root || !monacoRef.current) return;
        if (fedRootRef.current === props.root) return;
        var timer = setTimeout(function () { feedProjectFiles(monacoRef.current, props.root); }, 800);
        return function () { clearTimeout(timer); };
      }, [loadState, props.root]);

      function makeEditor(monaco) {
        if (editorRef.current) return;
        var themeName = monacoThemeName(monaco, themeModeRef.current);
        var prefOpts = editorPrefsToMonacoOptions(readEditorPrefs());
        var editor = monaco.editor.create(hostRef.current, {
          model: null,
          automaticLayout: true,
          theme: themeName,
          fontSize: readEditorFontSize(),   // 「设置」组可调（localStorage 持久化，默认 13）
          lineHeight: 21,
          fontFamily: cssVar('--ds-font-family-code'),
          tabSize: 4,
          insertSpaces: true,
          // ⚠ minimap（编辑器右缘的缩略图 + hover 半透明「小窗预览」+ 点/拖定位）——
          //   2026-09-28 用户点名永久去掉：「过时的东西，永远用不上」。
          //   VSCode/Monaco 默认是开的（editorOptions.ts:3469-3473 enabled:true / side:'right' /
          //   showSlider:'mouseover'），我们**故意不同**：永久关闭，且不提供开关（设置页不加这一项）。
          //   去掉的只是这块视图；定位能力一处没少：Ctrl+Shift+O 转到符号、Ctrl+P 快速打开、
          //   overview ruler 的诊断条纹都照旧（删视图 ≠ 砍功能，同 4981 行「保存按钮」先例）。
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          renderWhitespace: 'selection',
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          padding: { top: 8, bottom: 24 },
          fixedOverflowWidgets: true,
          // 【编辑器设置】页的偏好（存本机；改完实时生效 + 下次创建读回）
          unicodeHighlight: prefOpts.unicodeHighlight,
          wordBasedSuggestions: prefOpts.wordBasedSuggestions,
        });
        editorRef.current = editor;
        // 【编辑器设置】页改一项 → 从这里套到当前编辑器（登记后立刻用当前偏好对齐一次）
        var applier = function (opts) { try { editor.updateOptions(opts); } catch (e) { /* 已销毁 */ } };
        EDITOR_PREF_APPLIERS.push(applier);
        editor.updateOptions(editorPrefsToMonacoOptions(readEditorPrefs()));
        // ⑥ Agent 缝进编辑器：Ctrl+I / 右键菜单 → 带着上下文问 Agent
        // （VSCode 里 Copilot Chat 的行内入口就是 Ctrl+I；monaco 原生 addAction 一次拿到
        //   键位 + 右键项，属 §7「能买现成的就买」；回调走 ref，避免捕获首次渲染的闭包）
        // ⚠ 键位**不在这里写死**：一律由 applyEditorKeys() 按 KEYMAP 注册（可被用户改），
        //    这里只留右键菜单项（contextMenuGroupId），免得同一个动作出现两份键位。
        editor.addAction({
          id: 'dside.askAgent',
          label: '问 Agent（带上选中代码 / 当前文件 / 诊断）',
          contextMenuGroupId: '1_modification',
          contextMenuOrder: 0,
          run: function () { if (askOpenRef.current) askOpenRef.current(); },
        });
        // ⑤ 转到定义（F12 + 右键菜单）：monaco 这个 build **没有注册** definition 导航动作
        //    （2026-09-16 实测 136 个动作里只有 showDefinitionPreviewHover），所以自己补一个，
        //    内部走公开 API（见 gotoDefinition）。
        editor.addAction({
          id: 'dside.goToDefinition',
          label: '转到定义',
          contextMenuGroupId: 'navigation',
          contextMenuOrder: 1,
          run: function () { gotoDefinition(); },
        });
        editor.addAction({
          id: 'dside.peekDefinition',
          label: '查看定义预览',
          contextMenuGroupId: 'navigation',
          contextMenuOrder: 2,
          run: function () { runEditorAction('editor.action.showDefinitionPreviewHover'); },
        });
        // ⑭-② inline 建议（ghost text）：用 monaco 原生 inlineSuggest。**只在显式触发时请求模型**
        // （Alt+\ / 右键 / 命令面板），不跟着敲键自动跑 —— 一次触发 = 一次模型调用，成本可控。
        editor.addAction({
          id: 'dside.inlineSuggest',
          label: '内联建议（AI 补全）',
          contextMenuGroupId: '1_modification',
          contextMenuOrder: 3,
          run: function (ed) {
            var a = ed.getAction('editor.action.inlineSuggest.trigger');
            if (a) a.run();
            else if (props.status) props.status('当前 monaco 不支持内联建议');
          },
        });
        applyEditorKeys();
        // provider 是全局注册（重复注册会让同一次触发发多次请求）
        if (monaco.languages.registerInlineCompletionsProvider && !inlineProvRef.current) {
          inlineProvRef.current = monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
            provideInlineCompletions: function (model, position, context, token) {
              return requestInline(model, position, token);
            },
            freeInlineCompletions: function () { /* items 是普通对象，无需释放 */ },
            // ⚠ monaco 0.56 清理时调的是 **disposeInlineCompletions**（不是旧名
            // freeInlineCompletions）—— 缺了它会在接受/关闭建议后抛
            // `this.provider.disposeInlineCompletions is not a function`（实测踩到）。两个都实现。
            disposeInlineCompletions: function () { /* 同上，无需释放 */ },
          });
        }
      }

      // ── 编辑器侧键位（键位注册表 kind:'editor' 的那些）────────────────────
      // 规则：
      //   · 天工自己实现的动作（owned）：按当前键位注册（用户改了就改成新的）
      //   · monaco 内建动作（native）：默认**不动**（monaco 自己认），只有用户改过才
      //     ① 先把默认键位解绑（addKeybindingRules command:null）② 再绑到我们的命令上
      // 这样"没改过的照旧、改过的立刻生效"，不会平白多出一份重复绑定。
      var EDITOR_KEY_RUNNERS = {
        'file.save': function () { save(); },
        'editor.askAgent': function () { if (askOpenRef.current) askOpenRef.current(); },
        'editor.gotoDefinition': function () { gotoDefinition(); },
        'editor.inlineSuggest': function () { runEditorAction('editor.action.inlineSuggest.trigger'); },
      };
      function runEditorKeyEntry(entry) {
        var fn = EDITOR_KEY_RUNNERS[entry.id];
        if (fn) { fn(); return }
        if (entry.native) runEditorAction(entry.native);
      }
      function applyEditorKeys() {
        var ed = editorRef.current, monaco = monacoRef.current;
        if (!ed || !monaco) return;
        var acts = keyActsRef.current || {};
        Object.keys(acts).forEach(function (id) { try { acts[id].dispose(); } catch (e) { /* 已随编辑器销毁 */ } });
        keyActsRef.current = {};
        KEYMAP.forEach(function (entry) {
          if (entry.kind !== 'editor') return;
          var cur = resolvedKeys(entry.id);
          var def = entry.keys || '';
          if (cur && cur === def && !entry.owned) return;        // 没改过的 monaco 内建动作：不插手
          // ⚠ 只解绑"改过之后留下的旧默认"。别顺手给没改过的条目加：`command:null` 是"把这个组合置空"的
          //   全局规则，一旦同一组合上还要绑命令（就是 Shift+Delete 这种情况）就自相矛盾了。
          if (cur !== def && def && monaco.editor.addKeybindingRules) {
            try { monaco.editor.addKeybindingRules([{ keybinding: chordToMonaco(monaco, def), command: null }]); } catch (e) { /* 老版本 monaco */ }
          }
          if (!cur) return;                                       // 用户解绑了这一条
          var kb = chordToMonaco(monaco, cur);
          if (!kb) return;
          try {
            keyActsRef.current[entry.id] = ed.addAction({
              id: 'dside.key.' + entry.id,
              label: entry.title,
              keybindings: [kb],
              run: function () { runEditorKeyEntry(entry); },
            });
          } catch (e) { /* 键位无效：忽略这一条，不影响其它 */ }
        });
      }
      // 键位改了（快捷键设置页 / 全部恢复默认）→ 立刻重算编辑器侧绑定
      React.useEffect(function () {
        if (editorRef.current) applyEditorKeys();
      }, [props.keysRev]);

      // Shift+Delete → 删除行：**在自己的 capture 阶段拦**，不挂在 monaco 的键位解析上。
      // 原因：这个组合在可编辑区是 Blink 的**原生"剪切"**（monaco 侧本来就没有它的绑定），要赢只能靠
      // 更早一层把默认行为 preventDefault 掉；capture 阶段是确定的那一层（挂在 monaco 键位解析上要赌
      // 动态绑定的权重，不确定）。
      // 用 hostRef 判焦点 ⇒ 只有焦点真在编辑区才拦，树/终端不受影响，也不去壳里抢这个键。
      // 键位仍以 KEYMAP 为唯一事实来源（用户在快捷键设置页改绑后这里跟着变；改完 keysRev 一变就重订阅）。
      React.useEffect(function () {
        function onKey(e) {
          var want = normalizeChord(resolvedKeys('editor.deleteLines'));
          if (!want) return;                                  // 用户解绑了 → 这一条不管
          var got = normalizeChord(chordOfEvent(e));
          if (!got || got !== want) return;
          var host = hostRef.current;
          if (!host || !e.target || !host.contains(e.target)) return;   // 焦点不在编辑区 → 让给别处
          e.preventDefault();                                 // 挡住 Blink 的原生剪切
          e.stopPropagation();
          runEditorAction('editor.action.deleteLines');
        }
        window.addEventListener('keydown', onKey, true);
        return function () { window.removeEventListener('keydown', onKey, true) };
      }, [props.keysRev]);

      // ── ⑤ 语言智能：把 monaco 已有的能力接到 UI（2026-09-16）────────────────
      // 实测（tools/e2e5.mjs）：补全 / 悬停 / 大纲 / 重命名 / 格式化 / 诊断这些能力**本来就在跑**
      // （TS worker 提供，动作也都在），只是应用里没有入口；真正缺的只有"转到定义"这一族。
      // 所以这里做两件事：① 给已有动作开入口（命令面板/键位/右键）；② 自己实现转到定义。
      function runEditorAction(id) {
        var e = editorRef.current;
        if (!e) { if (props.status) props.status('没有打开的编辑器'); return; }
        var a = e.getAction(id);
        if (!a) { if (props.status) props.status('当前光标处不支持这个操作'); return; }
        try { a.run(); } catch (err) { if (props.status) props.status('执行失败：' + String((err && err.message) || err)); }
      }

      // worker 视角的路径 → 本应用的本地路径（转换规则集中在模块级的 localPathFromUri）
      function localPathFromTs(fileName) {
        return localPathFromUri(fileName);
      }
      function findModelByLocalPath(monaco, path) {
        var ms = monaco.editor.getModels();
        for (var i = 0; i < ms.length; i++) {
          var p = localPathFromTs(ms[i].uri.path || String(ms[i].uri));
          if (p.toLowerCase() === String(path).toLowerCase()) return ms[i];
        }
        return null;
      }

      // 转到定义：用 monaco **公开 API** 拿位置（不依赖缺失的动作），再交给上层跳转链路
      // （IdeApp 的 openTab + gotoReq，③ 已有；目标文件没打开时带字符偏移，由 doReveal 换算）
      function gotoDefinition() {
        var monaco = monacoRef.current;
        var ed = editorRef.current;
        if (!monaco || !ed) return;
        var model = ed.getModel();
        if (!model) { if (props.status) props.status('没有打开的编辑器'); return; }
        var lang = model.getLanguageId();
        var tsApi = monaco.languages && monaco.languages.typescript;
        if ((lang !== 'typescript' && lang !== 'javascript') || !tsApi || !tsApi.getTypeScriptWorker) {
          if (props.status) props.status('转到定义：目前只支持 TS/JS（其它语言等 ⑤ 的 LSP）');
          trace('ui', 'info', 'goto-definition-unsupported', { lang: lang });
          return;
        }
        var offset = model.getOffsetAt(ed.getPosition());
        tsApi.getTypeScriptWorker().then(function (getClient) {
          return getClient(model.uri).then(function (client) {
            return client.getDefinitionAtPosition(model.uri.toString(), offset);
          });
        }).then(function (defs) {
          if (!defs || !defs.length) {
            if (props.status) props.status('转到定义：光标处没有可跳转的定义');
            return;
          }
          var d = defs[0];
          var path = localPathFromTs(d.fileName);
          // 命中的是"镜像"喂进去的 @types 声明（虚拟路径）→ 换成磁盘上的真实位置再打开
          var realPath = typeMirrorRef.current[path.toLowerCase()];
          if (realPath) path = realPath;
          var start = (d.textSpan && typeof d.textSpan.start === 'number') ? d.textSpan.start : 0;
          var target = findModelByLocalPath(monaco, path);
          trace('ui', 'info', 'goto-definition', { from: String(model.uri.path), to: path, offset: start, modelOpen: !!target });
          if (!props.onRequestGoto) return;
          if (target) {
            var p = target.getPositionAt(start);
            props.onRequestGoto(path, p.lineNumber, p.column, null);
          } else {
            props.onRequestGoto(path, 1, 1, start);
          }
        }).catch(function (err) {
          if (props.status) props.status('转到定义失败：' + String((err && err.message) || err));
          trace('ui', 'error', 'goto-definition-failed', { error: String((err && err.message) || err) });
        });
      }

      // ⑤ 把项目源文件喂给 monaco 的 TS worker —— worker 只认识"编辑器打开过的模型"，
      // 所以只打开 b.ts 时，b.ts 里 `import { x } from './c'` 的 c.ts 里的符号既不能跳转
      // 也不能补全。这里在拿到工作空间根之后一次性 addExtraLib 进去（host /project-files
      // 已按预算打包；已作为模型打开的文件跳过，模型内容为准）。
      var fedRootRef = React.useRef(null);
      // 第三方类型是"镜像"喂进 worker 的（虚拟路径 node_modules/<pkg>/…），磁盘上并不存在 →
      // 记下 镜像路径 → 声明文件真实位置 的映射，供转到定义时换回去（见 gotoDefinition）
      var typeMirrorRef = React.useRef({});
      // ⑤ 项目源码清单（path + worker 眼里的文件名 + 内容），供"项目级全量诊断"逐个问 worker
      var projectFilesRef = React.useRef([]);

      // ⑤ 项目级诊断：monaco 只会为**已打开的模型**算 markers，所以未打开的文件要自己逐个问
      // worker（getSyntacticDiagnostics + getSemanticDiagnostics）。用同一个 worker 客户端串行跑，
      // 结果转成面板同款行格式 {path,line,col,sev,msg}；上限 300 个文件，避免超大项目卡住。
      function offsetToLineCol(text, offset) {
        var line = 1, col = 1;
        for (var i = 0; i < offset && i < text.length; i++) {
          if (text.charCodeAt(i) === 10) { line += 1; col = 1; } else { col += 1; }
        }
        return { line: line, col: col };
      }
      function scanProjectProblems() {
        var monaco = monacoRef.current;
        var tsApi = monaco && monaco.languages && monaco.languages.typescript;
        var files = projectFilesRef.current || [];
        if (!monaco || !tsApi || !tsApi.getTypeScriptWorker || !files.length) {
          return Promise.resolve({ rows: [], files: 0 });
        }
        var models = monaco.editor.getModels();
        if (!models.length) return Promise.resolve({ rows: [], files: 0 });
        var targets = files.slice(0, 300);
        var started = Date.now();
        return tsApi.getTypeScriptWorker().then(function (getClient) {
          return getClient(models[0].uri).then(function (client) {
            var rows = [];
            var scanned = 0;
            var chain = Promise.resolve();
            targets.forEach(function (t) {
              chain = chain.then(function () {
                return Promise.all([
                  client.getSyntacticDiagnostics(t.tsName).catch(function () { return [] }),
                  client.getSemanticDiagnostics(t.tsName).catch(function () { return [] }),
                ]).then(function (res) {
                  scanned += 1;
                  var lists = [res[0] || [], res[1] || []];
                  for (var li = 0; li < lists.length; li++) {
                    var list = lists[li];
                    for (var j = 0; j < list.length; j++) {
                      var dg = list[j];
                      if (!dg || typeof dg.start !== 'number') continue;
                      if (dg.category !== 1 && dg.category !== 0) continue; // 1=Error 0=Warning（TS DiagnosticCategory）
                      var pos = offsetToLineCol(t.content || '', dg.start);
                      rows.push({
                        path: t.path,
                        line: pos.line,
                        col: pos.col,
                        sev: dg.category === 1 ? 'error' : 'warn',
                        msg: String(dg.messageText === undefined ? '' : dg.messageText).split('\n')[0].slice(0, 200),
                      });
                    }
                  }
                });
              });
            });
            return chain.then(function () {
              trace('ui', 'info', 'project-diag-scan', { files: scanned, rows: rows.length, ms: Date.now() - started });
              return { rows: rows, files: scanned };
            });
          });
        }).catch(function (e) {
          trace('ui', 'error', 'project-diag-scan-failed', { error: String((e && e.message) || e) });
          return { rows: [], files: 0 };
        });
      }
      function feedProjectFiles(monaco, root) {
        if (!root || fedRootRef.current === root) return;
        fedRootRef.current = root;
        var d = monaco.languages && monaco.languages.typescript;
        if (!d || !d.typescriptDefaults) return;
        // 编译选项：先按"稳妥基线"起（tsconfig 读不到时也能用），随后用项目 tsconfig 覆盖。
        // monaco 的 setCompilerOptions 是**整体替换**，所以每次都要传完整对象。
        var T = d.typescriptDefaults ? monaco.languages.typescript : null;
        var baseline = null;
        try {
          baseline = {
            target: T.ScriptTarget.ESNext,
            module: T.ModuleKind.ESNext,
            moduleResolution: T.ModuleResolutionKind.NodeJs,
            jsx: T.JsxEmit.React,
            allowJs: true,
            allowNonTsExtensions: true,
            esModuleInterop: true,
          };
        } catch (e) { baseline = null; }
        var applyOpts = function (project) {
          if (!baseline) return {};
          var merged = {};
          var k;
          for (k in baseline) merged[k] = baseline[k];
          if (project) for (k in project) merged[k] = project[k];
          merged.allowNonTsExtensions = true; // monaco 必需项，项目配置不许把它关掉
          try {
            d.typescriptDefaults.setCompilerOptions(merged);
            d.javascriptDefaults.setCompilerOptions(merged);
          } catch (e) { /* 个别选项不兼容就算了，不影响已有能力 */ }
          return merged;
        };
        applyOpts(null);

        apiGet('/tsconfig', { root: root }).then(function (r) {
          if (!r || !r.files || !r.files.length) {
            trace('ui', 'info', 'tsconfig-none', { root: root });
            return;
          }
          var mergedCo = {};
          var parsed = 0;
          for (var i = 0; i < r.files.length; i++) { // host 已按 base → 派生 排序，后者覆盖前者
            var json = null;
            try { json = JSON.parse(stripJsonc(r.files[i].content)) } catch (e) { continue }
            parsed += 1;
            var co = json && json.compilerOptions;
            if (co && typeof co === 'object') for (var k in co) mergedCo[k] = co[k];
          }
          var mapped = mapTsconfigOptions(T, mergedCo);
          var applied = applyOpts(mapped);
          trace('ui', 'info', 'tsconfig-applied', {
            base: r.base, files: r.files.length, parsed: parsed,
            fromProject: Object.keys(mapped).join(','), applied: Object.keys(applied).join(','),
          });
          if (props.status) props.status('语言智能：已套用项目 tsconfig');
        }).catch(function () { /* 没有 tsconfig 或后端没起来 → 用基线默认 */ });
        apiGet('/project-files', { root: root }).then(function (r) {
          if (!r || !r.files) return;
          var fed = 0, open = 0;
          projectFilesRef.current = [];
          for (var i = 0; i < r.files.length; i++) {
            var f = r.files[i];
            if (!f || typeof f.content !== 'string' || !f.path) continue;
            // URI 必须过 monaco.Uri.parse().toString()：vscode-uri 会把盘符小写化、把冒号编码成
            // `%3A`（`file:///d%3A/...`）—— worker 内部用的就是这个形态；手拼 `file:///D:/...`
            // 与它不匹配 → 模块解析找不到这个"文件"（症状：markers 里一直报 cannot find module）
            var uri = monaco.Uri.parse('file:///' + String(f.path).replace(/\\/g, '/')).toString();
            // 项目级诊断要用的清单（含已打开的文件：它们的 tsName 就是这个 URI）
            projectFilesRef.current.push({ path: f.path, tsName: uri, content: f.content });
            if (findModelByLocalPath(monaco, f.path)) { open += 1; continue; }
            try {
              d.typescriptDefaults.addExtraLib(f.content, uri);
              d.javascriptDefaults.addExtraLib(f.content, uri);
              fed += 1;
            } catch (e) { /* 单个文件失败不影响其它 */ }
          }
          trace('ui', 'info', 'project-files-fed', {
            root: root, fed: fed, alreadyOpen: open, total: r.files.length, bytes: r.bytes, truncated: !!r.truncated,
          });
          if (props.status) props.status('语言智能就绪：已载入 ' + fed + ' 个项目文件');
        }).catch(function () { /* 后端没起来就算了，基本功能不受影响 */ });

        // 第三方类型（node_modules/@types/**/*.d.ts）：独立预算、独立埋点。
        // 有了它 `import { useState } from 'react'` 这类才有补全/悬停/跳转。
        apiGet('/type-files', { root: root }).then(function (r) {
          if (!r || !r.files || !r.files.length) return;
          var fed = 0;
          for (var i = 0; i < r.files.length; i++) {
            var f = r.files[i];
            if (!f || typeof f.content !== 'string' || !f.path) continue;
            if (findModelByLocalPath(monaco, f.path)) continue;
            try {
              // 同样必须走 monaco.Uri.parse().toString()（见上面 extraLib 那段注释 / §6 37）
              var uri = monaco.Uri.parse('file:///' + String(f.path).replace(/\\/g, '/')).toString();
              d.typescriptDefaults.addExtraLib(f.content, uri);
              d.javascriptDefaults.addExtraLib(f.content, uri);
              if (f.from && String(f.from).toLowerCase() !== String(f.path).toLowerCase()) {
                typeMirrorRef.current[String(f.path).toLowerCase()] = String(f.from);
              }
              fed += 1;
            } catch (e) { /* 单个文件失败不影响其它 */ }
          }
          trace('ui', 'info', 'type-files-fed', {
            root: root, fed: fed, total: r.files.length, bytes: r.bytes, truncated: !!r.truncated,
          });
        }).catch(function () { /* 没有 @types 或后端没起来：静默降级 */ });
      }

      // ⑭-② 内联建议：把光标前后上下文发给 host（host 用应用设置的模型做**一次性**调用），
      // 返回文本当 ghost text 展示；Tab 接受（monaco 默认键位）。
      function requestInline(model, position, token) {
        var monaco = monacoRef.current;
        if (!monaco || !model) return Promise.resolve({ items: [] });
        var last = model.getLineCount();
        var prefix = model.getValueInRange({
          startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column,
        });
        var suffix = model.getValueInRange({
          startLineNumber: position.lineNumber, startColumn: position.column,
          endLineNumber: last, endColumn: model.getLineMaxColumn(last),
        });
        var started = Date.now();
        return apiPost('/inline-suggest', {
          path: model.uri && model.uri.path ? model.uri.path : '',
          language: model.getLanguageId(),
          prefix: prefix.slice(-4000),
          suffix: suffix.slice(0, 1500),
        }).then(function (r) {
          if (token && token.isCancellationRequested) return { items: [] };
          if (!r || r.error || !r.text) {
            if (props.status) props.status('内联建议：' + ((r && (r.detail || r.error)) || '没有可用建议'));
            // 未配置模型时每敲一次都会走这里：60s 一条足够定位，重复的算进 suppressed
            traceEvery('inline-suggest-empty', 60000, 'ui', 'info', 'inline-suggest-empty', { ms: Date.now() - started, err: String((r && r.error) || '') });
            return { items: [] };
          }
          trace('ui', 'info', 'inline-suggest-ok', { ms: Date.now() - started, chars: r.text.length, model: r.model || '' });
          if (props.status) props.status('内联建议已生成（' + r.text.length + ' 字符 · ' + (r.ms || 0) + 'ms · Tab 接受）');
          return { items: [{ insertText: r.text }] };
        }).catch(function () {
          trace('ui', 'error', 'inline-suggest-failed', { ms: Date.now() - started });
          return { items: [] };
        });
      }

      function bootMonaco() {
        setLoadState('loading');
        loadMonaco().then(function (monaco) {
          monacoRef.current = monaco;
          makeEditor(monaco);
          setLoadState('ready');
        }).catch(function () {
          setLoadState('error');
        });
      }

      // ── monaco 一次性加载 + 编辑器实例创建 ──
      React.useEffect(function () {
        var alive = true;
        var onWinErr = function (ev) {
          var m = (ev && ev.message) || '';
          if (String(m).indexOf('monaco') >= 0 || String(m).indexOf('vs/') >= 0 || String((ev && ev.filename) || '').indexOf('monaco') >= 0) {
            console.error('[dsh-ide][monaco] window error:', ev && ev.message, (ev && ev.filename) || '', (ev && ev.lineno) || '');
          }
        };
        window.addEventListener('error', onWinErr);
        // monaco 与主题 JSON（④）都就绪后才建编辑器：首帧即用买的 VS Code 主题
        Promise.all([loadMonaco(), loadThemeFiles()]).then(function (arr) {
          var monaco = arr[0];
          if (!alive) return;
          monacoRef.current = monaco;
          try {
            makeEditor(monaco);
            setLoadState('ready');
          } catch (e) {
            console.error('[dsh-ide][monaco] makeEditor threw', e);
            setLoadState('error');
          }
        }).catch(function (e) {
          if (!alive) return;
          console.error('[dsh-ide][monaco] loadMonaco rejected', e);
          setLoadState('error');
        });
        return function () {
          alive = false;
          window.removeEventListener('error', onWinErr);
        };
      }, []);

      // ── 主题切换：实时读 token 重建主题 ──
      React.useEffect(function () {
        var editor = editorRef.current;
        if (!editor) return;
        editor.updateOptions({ theme: monacoThemeName(monacoRef.current, themeMode === 'dark' ? 'dark' : 'light') });
      }, [themeMode]);

      // ── 文件加载（切文件用缓存，⟳ 强制回读磁盘）──
      React.useEffect(function () {
        if (loadState !== 'ready' || !monacoRef.current || !editorRef.current) return;
        setError(null);
        setBinary(null);
        if (!file) {
          editorRef.current.setModel(null);
          modelRef.current = null;
          modelPathRef.current = null;
          setDirty(false);
          setLoadingFile(false);
          return;
        }
        if (lastTracedFileRef.current !== file.path) {
          lastTracedFileRef.current = file.path;
          trace('ui', 'info', 'open-file', { path: file.path });
        }
        // ⑥ 差异标签（diff://）也是伪路径，没有文件可读 —— 正文由差异视图占住（照 browser:// 的先例摘掉模型）。
        if (isReviewPath(file.path)) {
          try { editorRef.current.setModel(null); } catch (e) { /* 忽略 */ }
          modelRef.current = null;
          modelPathRef.current = null;
          setDirty(false);
          setLoadingFile(false);
          return;
        }
        // 内置浏览器标签：browser:// 是伪路径，没有文件可读（真去读会得到"文件不存在"，
        // 进而触发"标签消失"的兜底逻辑）→ 这里直接摘掉 monaco 模型，页面本体交给壳里的原生视图。
        if (isBrowserPath(file.path)) {
          try { editorRef.current.setModel(null); } catch (e) { /* 忽略 */ }
          modelRef.current = null;
          modelPathRef.current = null;
          setDirty(false);
          setLoadingFile(false);
          return;
        }
        // 设置标签（settings://）：同样没有文件可读，正文由设置面板占住。
        if (isSettingsPath(file.path)) {
          try { editorRef.current.setModel(null); } catch (e) { /* 忽略 */ }
          modelRef.current = null;
          modelPathRef.current = null;
          setDirty(false);
          setLoadingFile(false);
          return;
        }
        // 媒体预览（图片/音频/视频）：**不读文本** —— 平台的 readText 对二进制直接拒，
        // 而预览要的是原始字节（client 直接把 /raw-file 交给浏览器解码）。
        // monaco 侧摘掉模型（实例不卸载，切回文本文件立刻可用）。
        if (effMedia) {
          try { editorRef.current.setModel(null); } catch (e) { /* 忽略 */ }
          modelRef.current = null;
          modelPathRef.current = null;
          setDirty(false);
          setLoadingFile(false);
          trace('ui', 'info', 'open-media', { path: file.path, kind: effMedia });
          return;
        }
        var cache = modelsRef.current;
        var rec = cache[file.path];
        var forced = tickRef.current[file.path] !== refreshTick;
        if (rec && !forced) {
          attachModel(rec.model, rec, file.path);
          return;
        }
        setLoadingFile(true);
        apiGet('/read-file', { path: file.path }).then(function (r) {
          if (!fileRef.current || fileRef.current.path !== file.path) {
            setLoadingFile(false); // 已切走：放弃，但仍要清状态
            return;
          }
          if (!r || r.error) {
            // VSCode 的 Binary Viewer 分支：文本读不出来**不是错误**，别把标签关掉。
            // （过去这里走 onMissingFile → 标签直接消失 + 一句"读不了"，就是用户报的"打不开图"根因）
            if (r && r.code === 'FS_NOT_TEXT') {
              try { editorRef.current.setModel(null); } catch (e) { /* 忽略 */ }
              modelRef.current = null;
              modelPathRef.current = null;
              setDirty(false);
              setBinary({ path: file.path, size: typeof r.size === 'number' ? r.size : null, msg: r.error || '' });
              setLoadingFile(false);
              trace('ui', 'warn', 'open-binary-placeholder', { path: file.path, size: r.size });
              return;
            }
            setError((r && r.error) || 'network');
            setLoadingFile(false);
            // 会话恢复的兜底：这个文件其实读不出来了（被删/被移走/平台缓存没刷新）→
            // 别留一个空白标签，直接关掉并说明原因（VSCode 同款行为）
            if (props.onMissingFile) {
              try { props.onMissingFile(file.path, (r && r.error) || 'network'); } catch (e) { /* 忽略 */ }
            }
            return;
          }
          var monaco = monacoRef.current;
          var model;
          if (rec) {
            model = rec.model;
            model.setValue(r.content);
          } else {
            model = monaco.editor.createModel(
              r.content,
              languageFor(monaco, file.name),
              monaco.Uri.parse('file:///' + file.path.replace(/\\/g, '/')),
            );
            rec = { model: model, saved: '', baseVersion: null };
            cache[file.path] = rec;
          }
          rec.saved = r.content;
          rec.baseVersion = r.version ? String(r.version) : null;
          rec.ignoreUntil = Date.now() + 500;
          tickRef.current[file.path] = refreshTick;
          // （草稿的套用统一在 attachModel 里做：切标签走缓存分支时也要能套上，见那里的注释）
          // 手动 ⟳ 回读 = 用户已经拿到磁盘最新内容，冲突状态就此清掉
          if (extRef.current[file.path]) setExt(file.path, null);
          attachModel(model, rec, file.path);
          setLoadingFile(false);
        }).catch(function (e) {
          if (!fileRef.current || fileRef.current.path !== file.path) {
            setLoadingFile(false); // 已切走：放弃，但仍要清状态
            return;
          }
          setError(String((e && e.message) || e));
          setLoadingFile(false);
        });
      }, [file && file.path, refreshTick, loadState, effMedia, svgAsText]);

      // ── ③ 跳转意图（搜索/快速打开点击）：模型已挂则立即定位，
      // 未挂（新文件读盘中）则暂存，attachModel 后消费 ──
      React.useEffect(function () {
        var req = props.gotoReq;
        if (!req || loadState !== 'ready') return;
        if (modelPathRef.current && req.path && modelPathRef.current === req.path) {
          doReveal(req);
          return;
        }
        pendingGotoRef.current = req;
      }, [props.gotoReq ? props.gotoReq.seq : 0, loadState]);

      // ── ⑥ 外部改动轮询（2.5s，页面隐藏时跳过）──────────────────────
      React.useEffect(function () {
        if (loadState !== 'ready') return;
        var timer = setInterval(checkExternal, 2500);
        return function () { clearInterval(timer); };
      }, [loadState]);

      // 切/关文件时收掉差异浮层（浮层只属于当时那个文件）
      React.useEffect(function () { setDiff(null); }, [file && file.path]);

      // 差异浮层 Esc 关闭（VSCode 手感）
      React.useEffect(function () {
        if (!diffState) return;
        var onEsc = function (e) { if (e.key === 'Escape') setDiff(null); };
        window.addEventListener('keydown', onEsc);
        return function () { window.removeEventListener('keydown', onEsc); };
      }, [diffState ? diffState.seq : 0]);

      // 差异审阅：直接用 monaco 自带 diff 编辑器（§7 买现成零件：并排/差异导航全有）
      React.useEffect(function () {
        var d0 = diffState;
        var monaco = monacoRef.current;
        var host = diffHostRef.current;
        if (!d0 || !monaco || !host) return;
        var d = null, om = null, nm = null;
        try {
          var lang = languageFor(monaco, basenameOf(d0.path));
          d = monaco.editor.createDiffEditor(host, {
            automaticLayout: true,
            readOnly: true,
            originalEditable: false,
            renderSideBySide: true,
            // 差异视图也按语言级默认换行（md 的 diff 在 VSCode 里同样是软换行的）
            wordWrap: langEditorOptions(lang).wordWrap,
            theme: monacoThemeName(monaco, themeModeRef.current),
            fontSize: 12,
            lineHeight: 19,
            fontFamily: cssVar('--ds-font-family-code'),
            scrollBeyondLastLine: false,
            // 与 VSCode 一致：diff 的两个内层编辑器强制无 minimap
            // （VSCode diffEditorEditors.ts:200-202 `clonedOptions.minimap.enabled = false`）
            minimap: { enabled: false },
          });
          om = monaco.editor.createModel(String(d0.leftText || ''), lang, monaco.Uri.parse('inmemory://dsh-diff/orig-' + d0.seq));
          nm = monaco.editor.createModel(String(d0.rightText || ''), lang, monaco.Uri.parse('inmemory://dsh-diff/mod-' + d0.seq));
          d.setModel({ original: om, modified: nm });
          diffEdRef.current = { editor: d, models: [om, nm] };
        } catch (e) {
          trace('ui', 'error', 'diff-open-failed', { path: d0.path, error: String((e && e.message) || e) });
        }
        return function () {
          diffEdRef.current = null;
          try { if (d) d.dispose(); } catch (e) { /* 忽略 */ }
          try { if (om) om.dispose(); } catch (e) { /* 忽略 */ }
          try { if (nm) nm.dispose(); } catch (e) { /* 忽略 */ }
        };
      }, [diffState ? diffState.seq : 0, themeMode, loadState]);

      // ⑥ 第二/三刀：Agent 改动清单点「审阅」→ 复用上面这套差异浮层看改动前后；
      // 第三刀起带队列（一次审多个文件），items 有多个时走 openReview
      React.useEffect(function () {
        var r = props.reviewReq;
        if (!r || loadState !== 'ready') return;
        if (r.cleared) { setDiff(null); return; }   // 还原之后内容已变，关掉差异浮层
        if (r.items && r.items.length) {
          // ⑥ 重做（2026-10-10）：**改动审阅不再走浮层** —— 它的正文是"差异标签"（下面的 reviewEl，
          // 数据直接由本 props 喂过去）。只有**快照还原**还借这个浮层（那不是"本次 Agent 改动"，形态不同）。
          if (r.kind !== 'snapshot') return;
          openReview(r.items, r.index || 0, { snapTs: r.ts, snapLabel: r.label, canUndo: false });
          return;
        }
        openDiff(r.path, r.leftTitle, r.leftText, r.rightTitle, r.rightText, 'review', r.canUndo);
      }, [props.reviewReq ? props.reviewReq.seq : 0, loadState]);

      var overlay = null;
      if (loadState === 'loading') {
        overlay = h('div', { className: 'dside-editor-overlay' }, '编辑器加载中…');
      } else if (loadState === 'error') {
        overlay = h('div', { className: 'dside-editor-overlay' },
          '编辑器加载失败',
          h('button', { className: 'dside-btn small', onClick: bootMonaco }, '重试'),
        );
      } else if (!file) {
        overlay = h('div', { className: 'dside-editor-overlay' }, '从左侧资源管理器选择一个文件');
      } else if (loadingFile) {
        overlay = h('div', { className: 'dside-editor-overlay' }, '加载中…');
      }




      // 差异标签要审的那一项：从 reviewReq.items 里按标签路径里的 changeKey 找自己那份
      var reviewItem = null;
      if (file && isReviewPath(file.path) && props.reviewReq && props.reviewReq.items) {
        var rk = file.path.slice(REVIEW_SCHEME.length);
        for (var rIdx = 0; rIdx < props.reviewReq.items.length; rIdx++) {
          if (props.reviewReq.items[rIdx].changeKey === rk) { reviewItem = props.reviewReq.items[rIdx]; break; }
        }
      }
      var reviewEl = (file && isReviewPath(file.path))
        ? h(ReviewPane, {
            item: reviewItem, changeKey: file.path.slice(REVIEW_SCHEME.length),
            rev: (props.reviewReq ? props.reviewReq.seq : 0) + '|' + (reviewItem ? (reviewItem.hunks || []).length : 0),
            ready: loadState === 'ready',
            getMonaco: function () { return monacoRef.current },
            onKeepHunk: props.onHunkKeep, onUndoHunk: props.onHunkUndo,
            onKeepFile: props.onKeepFile, onRollbackFile: props.onRollbackChange,
            onClose: function () { if (props.onCloseTab) props.onCloseTab(file.path) },
            onStatus: status,
          })
        : null;

      // ── 内置浏览器：占住编辑器正文那块（工具栏留在 DOM 里，原生视图只吃工具栏以下；
      //    z-index 3 与媒体预览同级、低于差异审阅浮层 8）──
      var browserEl = (file && isBrowserPath(file.path))
        ? h(BrowserPane, {
            key: file.path,
            path: file.path,
            url: (file.browser && file.browser.url) || '',
            onTitle: props.onBrowserTitle,
            onStatus: props.status,   // 幻影开关切换时给一句状态栏反馈
          })
        : null;
      // ── 设置标签（settings://）：正文 = 引擎那套设置面板（已挂到主区的 'settings' key）。
      //    ⚠ 必须裹错误边界 —— 平台组件在渲染期抛错会顺着 root 槽把整个界面带崩（2026-10-10 白屏同款）。
      //    ⚠ renderSlot 从外壳经 props 传进来（授权跟着注册条目走，可以下传）；拿不到就不渲染。
      var settingsPage = (file && isSettingsPath(file.path)) ? file.path.slice(SETTINGS_SCHEME.length) : '';
      var closeSettingsTab = function () { if (props.onCloseTab) props.onCloseTab(file.path); };
      var settingsEl = (file && isSettingsPath(file.path))
        ? (settingsPage === 'keys'
            ? h(KeysView, { onClose: closeSettingsTab, onChanged: props.onKeysChanged })
            : (settingsPage === 'editor-prefs'
                ? h(EditorSettingsView, {
                    onClose: closeSettingsTab,
                    onChanged: function (next) {
                      // 编辑器已挂载时实时生效（桥走 Editor 暴露的 applyEditorPrefs；editorBridge 由外壳传入）
                      var b = props.editorBridge && props.editorBridge.current;
                      if (b && b.applyEditorPrefs) b.applyEditorPrefs(editorPrefsToMonacoOptions(next));
                    },
                  })
                : (settingsPage === 'agent'
                    ? h(AgentRulesView, { onClose: closeSettingsTab })
                    : (props.renderSlot
                    ? h(SlotErrorBoundary, { name: 'main/settings', fallback: '设置页暂时显示不了（细节见轨迹日志）' },
                        h('div', { className: 'dside-settings' },
                          props.renderSlot('main', {}, {
                            entryKey: 'settings',
                            // 面板右上那颗关闭按钮 = 关掉这个标签（VSCode 的设置标签也能关）
                            onClose: closeSettingsTab,
                          })))
                    : null))))
        : null;
      // ── Markdown 文档预览（2026-10-14）：**当前标签原地翻面**（VSCode 1.138 的
      //    markdown.togglePreview 语义），不是另开标签 ⇒ monaco 模型照旧挂着，
      //    翻回源码时未保存的编辑还在（预览只是盖在编辑器上面的一层）。
      var mdPreviewOn = !!(file && file.mdPreview && isMarkdownName(file.name));
      var mdPreviewEl = (file && mdPreviewOn)
        ? h(MdPreviewPane, {
            key: file.path + '|mdp',
            path: file.path, name: file.name,
            // 正文优先取 monaco 缓冲区（用户没保存的编辑也看得到，VSCode 同款）；
            // 拿不到（刚开、模型还没挂）就让面板自己读盘 —— 两边内容一致，不存在偏差
            getText: function () {
              var rec = modelsRef.current && modelsRef.current[file.path];
              if (rec && rec.model && !rec.model.isDisposed()) {
                var v = rec.model.getValue();
                if (typeof v === 'string') return v;
              }
              return null;
            },
          })
        : null;
      // ── 媒体预览 / 二进制占位卡：盖在 monaco 之上（monaco 不卸载，切回文本文件立刻可用）──
      var mediaEl = (file && effMedia)
        ? h(MediaPreview, {
            key: file.path,
            kind: effMedia, path: file.path, name: file.name,
            rev: refreshTick, apiRef: mediaApiRef,
            // VSCode 只对 .svg 给"以文本打开 / 以预览打开"的来回切换
            canToggleText: isSvgName(file.name),
            onOpenAsText: function () { setSvgAsText(file.path, true) },
            onStatus: status,
          })
        : null;
      var binaryEl = (file && binary && binary.path === file.path)
        ? h('div', { className: 'dside-binary' },
            h('div', { className: 'dside-binary-card' },
              h('div', { className: 'dside-binary-icon' }, '⚠'),
              // 文案对应 VSCode binaryEditor.ts 的 localize('binaryError', ...)
              h('div', { className: 'dside-binary-text' }, '这个文件不是文本，编辑器里显示不出来（二进制文件，或用了不支持的文本编码）。'),
              h('div', { className: 'dside-binary-sub' },
                (binary.size !== null ? fileSizeText(binary.size) + ' · ' : '') + file.path),
              h('button', { className: 'dside-btn small', onClick: forceOpenAsText }, '仍以文本方式打开'),
            ))
        : null;

      // ── ⑥ 问 Agent（编辑器 → Agent 上下文注入）────────────────────
      // VSCode 对照：Ctrl+I 打开行内对话、右键菜单有入口、选中内容自动成为上下文。
      // 这里先把"上下文注入"这一步做通：选中代码 + 当前文件 + 编辑器诊断 → 文本消息 → 当前会话。
      var askCtxState = React.useState(null);   // 打开时的上下文快照（稳定：打字不重算）
      var askCtx = askCtxState[0], setAskCtx = askCtxState[1];
      var askTextState = React.useState('');
      var askText = askTextState[0], setAskText = askTextState[1];
      var askHintState = React.useState('');
      var askHint = askHintState[0], setAskHint = askHintState[1];
      var askInputRef = React.useRef(null);

      // 输入条一出现就把焦点收进来（用 effect 而不是 setTimeout：headless/慢机器上
      // 定时器可能早于 React 挂载 DOM；没有焦点的输入条等于摆设）
      React.useEffect(function () {
        if (askCtx && askInputRef.current) askInputRef.current.focus();
      }, [askCtx]);

      function currentSelection() {
        var ed = editorRef.current, model = modelRef.current;
        if (!ed || !model) return null;
        var sel = ed.getSelection();
        if (!sel || sel.isEmpty()) return null;
        var text = model.getValueInRange(sel);
        if (!text) return null;
        return { text: text, startLine: sel.startLineNumber, endLine: sel.endLineNumber };
      }

      // 诊断来自 monaco 自己的 markers（TS/JS 走内建 worker；其它语言等 ⑤ LSP 接上后自动有）
      function collectMarkers(monaco, model) {
        var out = [];
        if (!monaco || !model || !model.uri) return out;
        try {
          var all = monaco.editor.getModelMarkers({ resource: model.uri }) || [];
          for (var i = 0; i < all.length && out.length < 20; i++) {
            var m = all[i];
            if (m.severity !== 8 && m.severity !== 4) continue; // 8=Error 4=Warning
            out.push({
              line: m.startLineNumber, col: m.startColumn,
              sev: m.severity === 8 ? 'error' : 'warning',
              msg: String(m.message || '').split('\n')[0].slice(0, 200),
            });
          }
        } catch (e) { /* 拿不到诊断就不带，不影响发问 */ }
        return out;
      }

      function buildAskContext() {
        var ed = editorRef.current, model = modelRef.current, f = fileRef.current;
        if (!ed || !model || !f) return null;
        var path = modelPathRef.current || f.path;
        var rec = modelsRef.current[path];
        var pos = ed.getPosition ? ed.getPosition() : null;
        return {
          path: path,
          rel: relDisplay(path, props.root || ''),
          lang: model.getLanguageId ? model.getLanguageId() : '',
          sel: currentSelection(),
          cursorLine: pos ? pos.lineNumber : 1,
          dirty: rec ? (model.getValue() !== rec.saved) : false,
          markers: collectMarkers(monacoRef.current, model),
        };
      }

      function openAsk() {
        var c = buildAskContext();
        if (!c) { status('先打开一个文件，再问 Agent'); return; }
        setAskCtx(c);
        setAskText('');
        setAskHint('');
        trace('ui', 'info', 'ask-open', {
          path: c.path,
          selLines: c.sel ? (c.sel.endLine - c.sel.startLine + 1) : 0,
          markers: c.markers.length,
        });
      }
      askOpenRef.current = openAsk;

      function composeAskMessage(c, question) {
        var out = [];
        out.push('【编辑器上下文】');
        out.push('文件: ' + (c.rel || c.path) + '（' + (c.lang || 'text') + '）'
          + (c.dirty ? ' —— 注意：编辑器里有未保存修改，下面的片段取自编辑器缓冲区，磁盘上还是旧内容' : ''));
        if (c.sel) {
          out.push('选中内容: 第 ' + c.sel.startLine + '-' + c.sel.endLine + ' 行');
          out.push('```' + (c.lang || '') + '\n' + c.sel.text + '\n```');
        } else {
          out.push('（没有选中内容，光标停在第 ' + c.cursorLine + ' 行；需要时你自己读这个文件）');
        }
        if (c.markers.length) {
          out.push('当前文件的编辑器诊断（' + c.markers.length + ' 条）:');
          for (var i = 0; i < c.markers.length; i++) {
            out.push('- ' + c.markers[i].line + ':' + c.markers[i].col + ' ' + c.markers[i].sev + ': ' + c.markers[i].msg);
          }
        }
        out.push('');
        out.push(question);
        return out.join('\n');
      }

      function closeAsk() { setAskCtx(null); setAskText(''); setAskHint(''); }

      function submitAsk() {
        var c = askCtx;
        if (!c) return;
        var q = String(askText || '').trim();
        if (!q) {
          // 提示放在输入条里（不放状态栏：状态栏会被 5s 的 refreshOverview 轮询覆盖）
          setAskHint('写下要让 Agent 做什么（例：解释这段 / 改成 async / 这里为什么报错）');
          return;
        }
        // 补一次诊断：打开输入条时 TS worker 可能还没产出 marker（异步）
        var rec = modelsRef.current[c.path];
        var fresh = collectMarkers(monacoRef.current, rec ? rec.model : null);
        if (fresh.length) {
          c = { path: c.path, rel: c.rel, lang: c.lang, sel: c.sel, cursorLine: c.cursorLine, dirty: c.dirty, markers: fresh };
        }
        var message = composeAskMessage(c, q);
        closeAsk();
        trace('ui', 'info', 'ask-send', { path: c.path, chars: message.length, markers: c.markers.length });
        if (props.onAskAgent) props.onAskAgent(message, c);
        else status('Agent 通道未就绪');
      }

      var askBar = askCtx ? h('div', { className: 'dside-ask' },
        h('div', { className: 'dside-ask-ctx' },
          h('b', null, askCtx.sel
            ? '🤖 选中 ' + (askCtx.sel.endLine - askCtx.sel.startLine + 1) + ' 行'
            : '🤖 当前文件'),
          h('span', { className: 'dside-ask-file', title: askCtx.path },
            (askCtx.rel || askCtx.path) + (askCtx.dirty ? '（有未保存修改）' : '')),
          askCtx.markers.length
            ? h('span', { className: 'dside-ask-diag' }, '诊断 ' + askCtx.markers.length + ' 条')
            : null,
        ),
        h('div', { className: 'dside-ask-row' },
          h('input', {
            ref: askInputRef,
            autoFocus: true,
            className: 'dside-ask-input',
            placeholder: '让 Agent 做什么？（Enter 发送，Esc 取消）',
            value: askText,
            onChange: function (e) { setAskText(e.target.value); if (askHint) setAskHint(''); },
            onKeyDown: function (e) {
              if (e.key === 'Enter') { e.preventDefault(); submitAsk(); }
              else if (e.key === 'Escape') { e.preventDefault(); closeAsk(); }
              e.stopPropagation(); // 别让全局键位路由（Ctrl+B/Ctrl+W…）抢走输入框里的按键
            },
          }),
          h('button', { className: 'dside-btn small primary', onClick: submitAsk }, '发送'),
          h('button', { className: 'dside-btn small', onClick: closeAsk }, '取消'),
        ),
        askHint ? h('div', { className: 'dside-ask-hint' }, askHint) : null,
      ) : null;

      // ── ⑤ 缺口提示：Agent 还没有这个语言的代码导航 ──────────────────
      // 判据是**装配单有没有覆盖这个扩展名**（= Agent 真有没有这个能力），跟"编辑器能不能高亮"
      // 无关（高亮是 monaco 自带的）。用户关心的是前者 —— 免得他吩咐 Agent 改一门它其实看不懂的语言。
      var navGapState = React.useState(null);
      var navGap = navGapState[0], setNavGap = navGapState[1];
      React.useEffect(function () {
        var monaco = monacoRef.current;
        if (!file || !file.path || isPseudoPath(file.path) || !monaco || loadState !== 'ready') { setNavGap(null); return; }
        if (effMedia || (binary && binary.path === file.path)) { setNavGap(null); return; }
        var name = basenameOf(file.path);
        var lang = languageFor(monaco, name);
        if (!lang || lang === 'plaintext' || lang === 'markdown') { setNavGap(null); return; }
        var dot = name.lastIndexOf('.');
        var ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
        if (!ext || isNavGapIgnored(lang)) { setNavGap(null); return; }
        apiGet('/nav-coverage').then(function (r) {
          if (!r || !r.ok || (r.extToLang && r.extToLang[ext])) { setNavGap(null); return; }
          setNavGap({ lang: lang, ext: ext, name: name });
          trace('ui', 'info', 'nav-gap-shown', { lang: lang, ext: ext });
        }).catch(function () { setNavGap(null); });
      }, [file && file.path, loadState, effMedia, refreshTick]);

      function navGapDismiss() {
        var g = navGap;
        if (!g) return;
        setNavGap(null);
        setNavGapIgnored(g.lang);   // 只对这门语言闭嘴，别的语言照旧提示
        trace('ui', 'info', 'nav-gap-dismiss', { lang: g.lang });
        setStatusText('不再提示 ' + g.lang + ' 的代码导航缺装');
      }
      function navGapAsk() {
        var g = navGap;
        if (!g) return;
        setNavGap(null);
        trace('ui', 'info', 'nav-gap-ask-agent', { lang: g.lang, ext: g.ext });
        if (props.onAskAgent) {
          props.onAskAgent('这个项目里有 ' + g.lang + ' 代码（例如 ' + g.name + '），但你现在没有它的代码导航，'
            + '查代码只能靠搜索猜。请你自己查一下该装什么语言服务器（包名、来源、体积、许可证），查完问我装不装。', {});
        } else {
          setStatusText('这个环境里没有对话入口，没法让 Agent 去装');
        }
      }
      var navBar = navGap
        ? h('div', { className: 'dside-extbar nav' },
            h('span', { className: 'msg' },
              'Agent 对 ' + navGap.lang + ' 还没有代码导航 —— 它查这个项目只能靠搜索猜。'),
            h('span', { className: 'sp' }),
            h('button', { className: 'dside-btn small', onClick: navGapAsk }, '让它去装'),
            h('button', { className: 'dside-btn small', onClick: navGapDismiss }, '不用了'),
          )
        : null;

      // ── 外部改动提示条（只针对当前文件；后台文件的改动状态先存着，切过去才提示）──
      // ⚠ 「已跟随磁盘」**不提示**（2026-10-10 对齐 VSCode）：文件没有被你编辑时被外部（Agent/别的程序）改了，
      //    编辑器静默跟随就行，弹条只白占地方（用户原话："功能也没用，而且很他妈多余"）。
      //    只有**真冲突**（本地有未保存改动）和**文件被删**才提示 —— 这两种 VSCode 也会打断你。
      var extInfo = file ? extRef.current[file.path] : null;
      var extBar = null;
      if (extInfo && file && extInfo.kind !== 'reloaded') {
        var extActions = [];
        var extCls = '';
        var extMsg = '';
        if (extInfo.kind === 'conflict') {
          extCls = 'warn';
          extMsg = '⚠ 磁盘上的文件已更改，而你有未保存的修改 —— 保存已被拦下，请先选保留哪一份';
          extActions.push(h('button', {
            className: 'dside-btn small',
            onClick: function () {
              var r = modelsRef.current[file.path];
              openDiff(file.path, '编辑器（我的）', r ? r.model.getValue() : '', '磁盘（外部/Agent）', extInfo.rightText, 'conflict');
            },
          }, '比较差异'));
          extActions.push(h('button', { className: 'dside-btn small primary', onClick: function () { acceptDiskVersion(file.path); } }, '采用磁盘版'));
          extActions.push(h('button', { className: 'dside-btn small danger', onClick: function () { forceSave(file.path); } }, '用我的覆盖磁盘'));
          extActions.push(h('button', { className: 'dside-btn small', onClick: function () { setExt(file.path, null); } }, '稍后'));
        } else if (extInfo.kind === 'missing') {
          extCls = 'err';
          extMsg = '⚠ 磁盘上已不存在该文件（被外部删除或移走）';
          extActions.push(h('button', { className: 'dside-btn small', onClick: function () { forceSave(file.path); } }, '用我的版本重建'));
          extActions.push(h('button', { className: 'dside-btn small', onClick: function () { setExt(file.path, null); } }, '知道了'));
        }
        extBar = h('div', { className: 'dside-extbar' + (extCls ? ' ' + extCls : '') },
          h('span', { className: 'msg', title: file.path }, extMsg),
          h('span', { className: 'sp' }),
          extActions);
      }

      // ── ⑥ 差异审阅浮层（占满编辑区，Esc/关闭退出）；第三刀起支持多文件队列 ──
      var queued = !!(diffState && diffState.items && diffState.items.length > 1);
      // ⑥ 第四刀（2026-10-10 对齐 VSCode）：横条只列**没处理**的块 —— 处理过（保留或撤销）就退场，
      // 全处理完横条整条消失。VSCode 里 Keep/Undo 是终态（源码 `supportsKeepUndo = false`），
      // 块连按钮一起消失，不存在"已保留 + 还问你要不要撤销"这种自相矛盾的状态。
      // 块号沿用**原始序号**（不重排，免得用户跟踪的那处突然换号）；
      // 跳转行号按**全部**块累加 —— 浮层里的拼贴文本包含已处理的块。
      var pendingHunks = [];
      if (diffState && diffState.kind === 'review' && diffState.hunks) {
        var pkAcc = 1;
        for (var pkIdx = 0; pkIdx < diffState.hunks.length; pkIdx++) {
          if (!diffState.hunks[pkIdx].status) pendingHunks.push({ hk: diffState.hunks[pkIdx], no: pkIdx + 1, line: pkAcc });
          pkAcc += hunkLines(diffState.hunks[pkIdx].after) + 1;
        }
      }
      var diffOverlay = diffState ? h('div', { className: 'dside-diff' },
        h('div', { className: 'dside-diff-head' },
          h('b', null, diffState.kind === 'snapshot' ? '快照还原' : '差异审阅'),
          h('span', { className: 'file', title: diffState.path }, basenameOf(diffState.path)),
          diffState.kind === 'review' && diffState.status
            ? h('span', { className: 'dside-change-tag' }, diffState.status === 'kept' ? '已保留' : '已撤销')
            : null,
          diffState.kind === 'snapshot' && diffState.snapStatus
            ? h('span', { className: 'dside-change-tag' },
                diffState.snapStatus === 'added' ? '快照之后新增' : (diffState.snapStatus === 'deleted' ? '现在已被删掉' : '内容已变'))
            : null,
          h('span', null, '左 = ' + diffState.leftTitle + ' · 右 = ' + diffState.rightTitle),
          h('span', { className: 'sp' }),
          queued ? h('span', null, '第 ' + (diffState.index + 1) + '/' + diffState.items.length + ' 个文件') : null,
          queued
            ? h('button', {
                className: 'dside-btn small',
                disabled: diffState.index <= 0,
                onClick: function () { gotoReviewItem(diffState.index - 1); },
              }, '← 上一个')
            : null,
          queued
            ? h('button', {
                className: 'dside-btn small',
                disabled: diffState.index >= diffState.items.length - 1,
                onClick: function () { gotoReviewItem(diffState.index + 1); },
              }, '下一个 →')
            : null,
          diffState.kind === 'conflict'
            ? h('button', {
                className: 'dside-btn small primary',
                onClick: function () { acceptDiskVersion(diffState.path); setDiff(null); },
              }, '采用磁盘版')
            : null,
          diffState.kind === 'conflict'
            ? h('button', {
                className: 'dside-btn small danger',
                onClick: function () { var p = diffState.path; setDiff(null); forceSave(p); },
              }, '用我的覆盖磁盘')
            : null,
          diffState.kind === 'review' && diffState.canUndo
            ? h('button', { className: 'dside-btn small danger', onClick: undoReviewItem }, '撤销这次改动')
            : null,
          // 反悔药：快照差异里直接还原（单文件 / 整份快照）
          diffState.kind === 'snapshot'
            ? h('button', {
                className: 'dside-btn small',
                onClick: function () { if (props.onSnapshotRestore) props.onSnapshotRestore(diffState.snapTs, diffState.snapLabel, [diffState.path]); },
              }, '还原这个文件')
            : null,
          diffState.kind === 'snapshot'
            ? h('button', {
                className: 'dside-btn small primary',
                onClick: function () { if (props.onSnapshotRestore) props.onSnapshotRestore(diffState.snapTs, diffState.snapLabel, null); },
              }, '还原整个快照')
            : null,
          h('button', { className: 'dside-btn small', onClick: function () { setDiff(null); } }, '关闭 (Esc)'),
        ),
        queued
          ? h('div', { className: 'dside-diff-chips' }, diffState.items.map(function (it, i) {
              var undone = !!(diffState.undone || {})[it.path];
              return h('div', {
                key: it.path + '#' + i,
                className: 'dside-chip' + (i === diffState.index ? ' active' : '') + (undone ? ' undone' : ''),
                title: it.path + (undone ? '（已撤销）' : (it.status === 'kept' ? '（已保留）' : '')),
                onClick: function () { gotoReviewItem(i); },
              }, (it.isCreate ? '＋ ' : '✎ ') + it.name);
            }))
          : null,
        // ⑥ 第四刀：改动块横条 —— 只列没处理的块，每块两个动作（保留 / 撤销）。
        // 处理过的块退场，全退完整条消失（见上面 pendingHunks 的注释）。
        pendingHunks.length
          ? h('div', { className: 'dside-hunks' },
              h('span', { className: 'dside-hunks-label' }, '还有 ' + pendingHunks.length + ' 处没处理'),
              pendingHunks.map(function (pu) {
                return h('span', {
                  key: pu.hk.key,
                  className: 'dside-hunk',
                  title: '跳到这一处（第 ' + pu.line + ' 行起）',
                  onClick: function () { gotoHunkLine(pu.line); },
                },
                  h('span', { className: 'idx' }, '#' + pu.no),
                  h('button', {
                    className: 'dside-btn small',
                    title: '保留这一处（其余不动）',
                    // 块状态表在改动清单组件里，这一层够不着 ⇒ 动作只能走 props 递进来的回调
                    onClick: function (e) { e.stopPropagation(); if (props.onHunkKeep) props.onHunkKeep(diffState.changeKey, pu.hk.key); },
                  }, '保留'),
                  h('button', {
                    className: 'dside-btn small danger',
                    title: '只把这一处还原回去',
                    onClick: function (e) { e.stopPropagation(); if (props.onHunkUndo) props.onHunkUndo(diffState.changeKey, pu.hk.key); },
                  }, '撤销'),
                );
              }))
          : null,
        h('div', { className: 'dside-diff-body' },
          h('div', { className: 'dside-diff-monaco', ref: diffHostRef }),
        ),
      ) : null;

      var tabEls = tabs.map(function (t) {
        var active = t.path === activePath;
        var cls = 'dside-tab' + (active ? ' active' : '')
          + (t.preview ? ' preview' : '')
          + (t.pinned ? ' pinned' : '')
          + (t.pinned && props.pinnedCompact ? ' compact' : '');
        return h('div', {
          key: t.path,
          className: cls,
          title: t.path + (t.preview ? '\n（预览标签：双击标签、或开始编辑即转为固定打开）' : ''),
          // ⑫ A4 拖拽排序（VSCode 同款）：拖到目标标签上就插到它前面
          draggable: true,
          onDragStart: function (e) {
            dragTabRef.current = t.path;
            try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.path); } catch (err) { /* 某些环境禁止 */ }
          },
          onDragOver: function (e) { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ } },
          onDrop: function (e) {
            e.preventDefault();
            var from = dragTabRef.current || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
            dragTabRef.current = null;
            if (from && from !== t.path && props.onMoveTab) props.onMoveTab(from, t.path);
          },
          onClick: function () { if (props.onActivate) props.onActivate(t.path); },
          // 双击预览标签 = 转成固定打开（VSCode：双击树里的文件是同一个意思）
          onDoubleClick: function () { if (props.onPromote) props.onPromote(t.path); },
          onAuxClick: function (e) { if (e.button === 1) { e.preventDefault(); if (props.onCloseTab) props.onCloseTab(t.path); } },
          // ⑮ 标签右键菜单（VSCode 的 Editor Tab Context：关闭族 / 固定 / 路径族）
          onContextMenu: function (e) { e.preventDefault(); e.stopPropagation(); if (props.onTabContext) props.onTabContext(t.path, e); },
        },
          h('span', { className: 'dside-dot' + (t.dirty ? ' dirty' : '') }),
          // 固定标签在「收窄成图标」模式下只显示类型图标
          (t.pinned && props.pinnedCompact) ? h('span', { className: 'dside-tab-icon' }, iconFor({ type: 'file', name: t.name })) : null,
          // 内置浏览器标签带个地球标记：它的"路径"是 browser:// 伪协议，光看名字分不出是网页还是文件
          isBrowserPath(t.path) ? h('span', { className: 'dside-tab-globe', title: '内置浏览器标签' }, '🌐') : null,
          isReviewPath(t.path) ? h('span', { className: 'dside-tab-globe', title: '改动差异标签' }, '⇄') : null,
          isSettingsPath(t.path) ? h('span', { className: 'dside-tab-globe', title: '设置标签' }, '⚙') : null,
          h('span', { className: 'dside-tab-name' }, t.name),
          // VSCode 同款：固定标签上的动作按钮是「取消固定」而不是关闭（其中键/Ctrl+W 也受保护）
          t.pinned
            ? h('button', {
                className: 'dside-tab-unpin',
                title: '取消固定',
                onClick: function (e) { e.stopPropagation(); if (props.onTogglePin) props.onTogglePin(t.path); },
              }, '📌')
            : h('button', {
                className: 'dside-tab-close',
                title: '关闭',
                onClick: function (e) { e.stopPropagation(); if (props.onCloseTab) props.onCloseTab(t.path); },
              }, '×'),
        );
      });

      return h('div', { className: 'dside-editor' },
        h('div', { className: 'dside-editor-tabs' },
          h('div', { className: 'dside-tablist' }, tabEls),
          h('div', { className: 'dside-editor-meta' },
            // SVG 被"以文本打开"后，回到预览的入口（VSCode 把这条放在编辑器标题栏 navigation 组）
            (file && svgAsText)
              ? h('button', {
                  className: 'dside-btn small',
                  title: '以图片预览方式打开（VSCode 对 .svg 才有这个来回切换）',
                  onClick: function () { setSvgAsText(file.path, false) },
                }, '🖼 以预览打开')
              : null,
            // Markdown 的源码/预览开关：VSCode 把这两个图标放在编辑器标题栏（navigation 组），同一位置
            (file && !isPseudoPath(file.path) && isMarkdownName(file.name))
              ? h('button', {
                  className: 'dside-btn small' + (mdPreviewOn ? ' primary' : ''),
                  title: mdPreviewOn
                    ? '回到 Markdown 源码（Ctrl+Shift+V）'
                    : '打开 Markdown 预览：左侧带目录，点标题可跳（Ctrl+Shift+V）',
                  onClick: function () { if (props.onToggleMdPreview) props.onToggleMdPreview(); },
                }, mdPreviewOn ? '⟨⟩ 源码' : '📖 预览')
              : null,
            dirty && !saving ? '● 未保存' : (saving ? '保存中…' : ''),
          ),
          // ⚠ 这里曾有一个「保存 (Ctrl+S)」按钮 —— 2026-09-21 用户看截图后点名去掉
          // （"中面板右上角那个保存按钮去掉"）。保存能力一处没少：Ctrl+S（monaco 侧）、
          // 「操作」组、命令面板、Ctrl+K S 全部保存都在。删按钮 ≠ 砍功能（§5.1）。
        ),
        navBar,
        extBar,
        h('div', { className: 'dside-editor-body' },
          error ? h('div', { className: 'dside-editor-error' }, String(error)) : null,
          h('div', { className: 'dside-editor-host' },
            overlay,
            askBar,
            // monaco 专用叶子容器：React 永远不往里渲染子节点，
            // 否则重渲染会把 monaco 插入的编辑器 DOM 清掉（2026-08-25 踩坑）；
            // 且排在 React 管理的兄弟节点之后（monaco 若插在容器后仍是尾部）
            h('div', { className: 'dside-editor-monaco', ref: hostRef }),
            diffOverlay,
            // ⑥ 差异标签的正文（改动审阅的正式形态 —— 不再是浮层）
            reviewEl,
            // 设置标签的正文（settings://，2026-10-12）
            settingsEl,
            // Markdown 预览正文（2026-10-14；z-index 4，盖住 monaco、低于差异浮层）
            mdPreviewEl,
            // 内置浏览器 / 媒体预览 / 二进制占位卡（z-index 3；差异审阅浮层是 8，仍然盖得住）
            browserEl,
            mediaEl,
            binaryEl,
          ),
        ),
      );
    }

    // ── Agent 面板（官方 sessions 数据层：列表/历史/流式/过滤）──
    function textOfContent(content) {
      var out = '';
      if (!Array.isArray(content)) return out;
      for (var i = 0; i < content.length; i++) {
        var b = content[i];
        if (b && b.type === 'text' && typeof b.text === 'string') out += b.text;
      }
      return out;
    }
    function textOfBlocks(blocks) {
      var out = '';
      if (!Array.isArray(blocks)) return out;
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        if (b && b.kind === 'text' && typeof b.text === 'string') out += b.text;
      }
      return out;
    }
    function reasoningOf(blocks) {
      if (!Array.isArray(blocks)) return '';
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        if (b && b.kind === 'reasoning' && typeof b.text === 'string') return b.text;
      }
      return '';
    }
    function formatWhen(t) {
      if (typeof t !== 'number') return '';
      var d = new Date(t);
      var now = new Date();
      function p(n) { return String(n).padStart(2, '0'); }
      var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
      if (sameDay) return p(d.getHours()) + ':' + p(d.getMinutes());
      return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function shortTitle(summary) {
      if (!summary) return '';
      var t = summary.projectionValues && summary.projectionValues.title;
      if (typeof t === 'string' && t.trim()) return t;
      return (summary.sessionId || '').slice(0, 8);
    }

    // Markdown 块 + 错误边界：平台组件契约变动（比如新增必填 props）会让渲染抛错，
    // 而 ui-slots 对**渲染崩溃的占用项会退役**整块（§6 25）→ 宁可回退成纯文本，
    // 也不能让整个 IDE 面板消失。
    class MdBlock extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }
      static getDerivedStateFromError(err) { return { err: err }; }
      render() {
        if (this.state.err || !MarkdownText) {
          return h('div', { className: 'dside-md-fallback' }, String(this.props.text || ''));
        }
        return h('div', { className: 'dside-md' },
          h(MarkdownText, {
            text: String(this.props.text || ''),
            streaming: !!this.props.streaming,
            labels: MARKDOWN_LABELS,
          }));
      }
    }

    // ── Markdown 文档预览（2026-10-14，用户拍板"目录走页内目录"）───────────────
    // 正文白送：引擎自带的 MarkdownText（Agent 回话那套，代码高亮/表格/公式/脚注都在），
    // 我们只做两件引擎不给的事 —— **目录**和**跳转**。
    // 目录从**渲染出来的 DOM** 里收标题，不另写一遍 markdown 解析：自己再解析一套，
    // 迟早跟真正渲染出来的东西对不上（代码块、HTML 块、缩进标题都会漂），而目录点半天跳不到的地方最刺眼。
    // 跳转也不走 `#锚点`：引擎那个渲染器不给标题加 id、且站内锚点被它禁掉
    // （ui-primitives/src/markdown/render.tsx 的 sanitizeUrl 只放行 http/https/mailto）。
    class MdPreviewPane extends React.Component {
      constructor(props) {
        super(props);
        this.state = { text: null, err: '', toc: [], active: -1 };
        this.scrollRef = React.createRef();
        this.docRef = React.createRef();
        this.headEls = [];
        this.gone = false;
        this.onScroll = this.onScroll.bind(this);
      }
      static getDerivedStateFromError(err) { return { err: String((err && err.message) || err) }; }
      componentDidMount() { this.load(); }
      // 换文件由外层 key 触发重挂，这里只管"正文换了就重收目录"。
      // ⚠ 比的是 **prevState**：比 prevProps.text 恒为 true（props 里没有 text 这个字段）⇒
      //   每次更新都 collect → 每次 collect 又 setState ⇒ 无限重渲染，React 直接抛
      //   "Maximum update depth exceeded"，整个面板只剩一句报错（2026-10-14 实测栽过）。
      componentDidUpdate(prevProps, prevState) {
        if (prevState.text !== this.state.text) this.collect();
      }
      componentWillUnmount() { this.gone = true; }
      load() {
        var self = this;
        var t = null;
        try { t = this.props.getText ? this.props.getText() : null; } catch (e) { t = null; }
        if (typeof t === 'string') { this.setState({ text: t, err: '' }); return; }
        apiGet('/read-file', { path: this.props.path }).then(function (r) {
          if (self.gone) return;
          if (!r || r.error) { self.setState({ text: '', err: String((r && r.error) || 'network') }); return; }
          self.setState({ text: String(r.content || ''), err: '' });
        }).catch(function (e) {
          if (self.gone) return;
          self.setState({ text: '', err: String((e && e.message) || e) });
        });
      }
      collect() {
        var root = this.docRef.current;
        var els = root ? root.querySelectorAll('h1,h2,h3,h4,h5,h6') : [];
        var toc = [];
        this.headEls = [];
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          var lv = Number(String(el.tagName || '').slice(1));
          if (!(lv >= 1 && lv <= 6)) lv = 1;
          toc.push({ level: lv, text: String(el.textContent || '').trim() || ('（第 ' + (i + 1) + ' 个标题）') });
          this.headEls.push(el);
        }
        this.setState({ toc: toc, active: toc.length ? 0 : -1 });
      }
      onScroll() {
        var box = this.scrollRef.current;
        if (!box || !this.headEls.length) return;
        var top = box.getBoundingClientRect().top;
        var idx = 0;
        // 判据用**标题顶边**顶到容器顶（不是底边）：标题本身就十几到几十像素高，
        // 拿底边判，跳到某一节后那一节还压着线、高亮就掉回上一节（2026-10-14 探针实测）
        for (var i = 0; i < this.headEls.length; i++) {
          var r = this.headEls[i].getBoundingClientRect();
          if (r.top - top <= 12) idx = i;
          else break;
        }
        // 到底了就认最后一节：末尾那节滚不到顶端（下面没内容了）。**只在真能滚时兜底** ——
        // 短文档压根不滚，加上这条会让高亮永远钉在最后一节
        if (box.scrollHeight > box.clientHeight + 4
          && box.scrollTop + box.clientHeight >= box.scrollHeight - 4) idx = this.headEls.length - 1;
        if (idx !== this.state.active) this.setState({ active: idx });
      }
      jumpTo(i) {
        var box = this.scrollRef.current, el = this.headEls[i];
        if (!box || !el) return;
        var delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
        box.scrollTop = Math.max(0, box.scrollTop + delta - 8);
        this.setState({ active: i });
      }
      render() {
        var self = this;
        var st = this.state;
        if (st.err) {
          return h('div', { className: 'dside-mdpane' },
            h('div', { className: 'dside-mdpane-msg' }, '预览打不开：' + st.err));
        }
        var tocEl = st.toc.length
          ? h('div', { className: 'dside-mdpane-toc-list' },
              st.toc.map(function (it, i) {
                return h('button', {
                  key: 't' + i, type: 'button',
                  className: 'dside-toc-item lv' + it.level + (st.active === i ? ' on' : ''),
                  title: it.text,
                  onClick: function () { self.jumpTo(i); },
                }, it.text);
              }))
          : h('div', { className: 'dside-mdpane-toc-empty' }, '这份文档里没有标题，也就没有目录。');
        return h('div', { className: 'dside-mdpane' },
          h('div', { className: 'dside-mdpane-toc' },
            h('div', { className: 'dside-mdpane-toc-title' }, '目录'),
            tocEl),
          h('div', { className: 'dside-mdpane-body', ref: this.scrollRef, onScroll: this.onScroll },
            h('div', { className: 'dside-mdpane-doc', ref: this.docRef },
              st.text === null
                ? h('div', { className: 'dside-mdpane-msg' }, '加载中…')
                : h(MdBlock, { text: st.text }))),
        );
      }
    }

    function AssistantBubble(props) {
      var node = props.node, partial = props.partial;
      var reasonState = React.useState(false);
      var showReason = reasonState[0], setShowReason = reasonState[1];
      var blocks = (node && node.blocks) || (partial && partial.blocks) || [];
      var text = textOfBlocks(blocks);
      var reason = reasoningOf(blocks);
      var cls = 'dside-msg assistant' + (partial ? ' partial' : '') + (node && node.interrupted ? ' stopped' : '');
      var kids = [];
      if (reason) {
        kids.push(h('button', {
          className: 'dside-reason-toggle',
          onClick: function () { setShowReason(!showReason); },
        }, showReason ? '▾ 收起思考' : '▸ 思考过程 (' + reason.length + ' 字)'));
        if (showReason) kids.push(h('div', { className: 'dside-reason-body' }, reason));
      }
      // AI 回复按 Markdown 渲染（流式中也走流式渲染：streaming=true 做增量解析）
      kids.push(text
        ? h(MdBlock, { key: 'md', text: text, streaming: !!partial })
        : (partial ? '…' : '(无文本内容)'));
      if (node && node.interrupted) kids.push(h('span', { className: 'dside-stop-note' }, '⏹ 已停止'));
      if (node && node.time) kids.push(h('span', { className: 'dside-msg-time' }, formatTime(node.time)));
      return h('div', { className: cls }, kids);
    }

    function ToolRow(props) {
      var node = props.node;
      var name = (node.call && node.call.name) || node.callId;
      return h('div', { className: 'dside-toolrow' + (node.isError ? ' err' : '') },
        '🔧 ' + name + (node.isError ? ' ✗' : ' ✓'));
    }

    // ── 对话投影（2026-09-10 修：平台把对话从 SessionSnapshot 搬走了）──────
    // 旧行为：binding.session.getSnapshot().nodes / .partial —— 现在快照只剩元数据
    // （queue/running/openState/hasMore…），对话改由 binding.eventSource 提供：
    //   SessionEventWindow.entries = [{type:'event',event} | {type:'transient',event}]
    //   transient 是流式帧 assistant/live-chunk（data.chunk: text-delta / reasoning-delta / …）
    // 这里把事件投影成面板原有的节点形状，渲染组件不动。
    function contentToBlocks(content) {
      var out = [];
      if (!Array.isArray(content)) return out;
      for (var i = 0; i < content.length; i++) {
        var b = content[i];
        if (b && b.type === 'text' && typeof b.text === 'string') out.push({ kind: 'text', text: b.text });
      }
      return out;
    }

    // ⑥ 第二刀：从会话事件里投影改动记录（待处理清单与历史视图共同的数据源）。
    // 数据源形状（探针实测 tools/probe-session-events.mjs，别照猜）：
    //   tool/call   data = { turn, step, callId, name, arguments }
    //   tool/result data = { turn, step, message:{ source:{kind:'tool',callId},
    //                       content:[{type:'tool-result',content,isError}] }, meta:{ diffs:[...] } }
    //   meta.diffs = [{ path, oldText, newText }]（平台自己算好的 diff basis，与官方 diff 卡片同源）
    // 注意：write 新建文件时 before=null → diffs 是空数组，要靠工具渲染文本前缀区分
    // "新建"与"无变化覆写"（后者若当成新建去撤销就会误删既有文件）。
    function projectConversation(win, snap) {
      var entries = (win && win.entries) || [];
      var nodes = [];
      var toolIndex = {};   // callId -> 工具行下标（tool/call 与 tool/result 合并成一行）
      var callInfo = {};    // callId -> { name, args }（tool/result 里没有工具名与参数）
      var changes = [];     // 本轮文件改动（按事件顺序）
      var liveText = '';
      var liveReason = '';
      // ⑭ 长任务进度（用户实测痛点：单轮跑到第 54 步、十几分钟，界面只有"运行中"三个字）
      var progStep = 0;         // 本轮最大 step（step/start·assistant/message·tool/* 都带）
      var progTurn = 0;         // 最大 turn
      var progTurnStart = 0;    // 本轮开始时间（turn/start 的 time，epoch ms）
      var progFirstTime = 0;    // 兜底：第一条事件的时间
      var pendingCalls = {};    // callId -> 工具名（还没等到 result 的 = 正在跑）
      var lastTurnEnd = null;   // { turn, reason, time, step }
      var toolCount = 0;        // 本轮工具调用次数
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var ev = entry && entry.event;
        if (!ev) continue;
        var data = ev.data || {};
        if (!progFirstTime && ev.time) progFirstTime = ev.time;
        if (typeof data.step === 'number' && data.step > progStep) progStep = data.step;
        if (typeof data.turn === 'number' && data.turn > progTurn) progTurn = data.turn;
        if (ev.type === 'turn/start' && ev.time) progTurnStart = ev.time;
        if (ev.type === 'turn/end') {
          lastTurnEnd = { turn: data.turn, reason: data.reason, time: ev.time, step: progStep, tools: toolCount };
        }
        if (entry.type === 'transient') {
          var ch = data.chunk || {};
          if (ch.type === 'text-delta' && typeof ch.text === 'string') liveText += ch.text;
          else if (ch.type === 'reasoning-delta' && typeof ch.text === 'string') liveReason += ch.text;
          continue;
        }
        if (ev.type === 'user/message') {
          var src = data.source || {};
          if (src.kind !== 'user') continue;   // 系统注入（runtime-context / system-reminder）不显示
          nodes.push({ kind: 'user', seq: ev.seq, time: ev.time, content: data.content });
        } else if (ev.type === 'assistant/message') {
          var streamedReason = liveReason;
          liveText = '';
          liveReason = '';
          var blocks = contentToBlocks(data.message && data.message.content);
          if (streamedReason) blocks.unshift({ kind: 'reasoning', text: streamedReason });
          if (blocks.length) {
            nodes.push({ kind: 'assistant', seq: ev.seq, time: ev.time, blocks: blocks, interrupted: !!data.interrupted });
          }
        } else if (ev.type === 'tool/call') {
          if (data.callId !== undefined) {
            // 注意：事件里的 arguments 是 JSON 字符串（不是对象）——直接当对象取字段会全 undefined
            var rawArgs = data.arguments;
            var parsedArgs = rawArgs;
            if (typeof rawArgs === 'string') {
              try { parsedArgs = JSON.parse(rawArgs); } catch (e) { parsedArgs = null; }
            }
            callInfo[data.callId] = { name: data.name, args: parsedArgs || {} };
            pendingCalls[data.callId] = data.name || 'tool';
            toolCount += 1;
          }
          toolIndex[data.callId] = nodes.length;
          nodes.push({ kind: 'tool-result', seq: ev.seq, time: ev.time, callId: data.callId, call: { name: data.name }, isError: false });
        } else if (ev.type === 'tool/result') {
          var msg = data.message || {};
          var msrc = msg.source || {};
          var first = (Array.isArray(msg.content) ? msg.content[0] : null) || {};
          var idx = toolIndex[msrc.callId];
          if (msrc.callId !== undefined) delete pendingCalls[msrc.callId];
          if (idx !== undefined && nodes[idx]) nodes[idx].isError = !!first.isError;
          else nodes.push({ kind: 'tool-result', seq: ev.seq, time: ev.time, callId: msrc.callId, call: null, isError: !!first.isError });
          // ── 改动收集（⑥ 第二刀）──
          var ci = msrc.callId !== undefined ? callInfo[msrc.callId] : null;
          var hunks = data.meta && Array.isArray(data.meta.diffs) ? data.meta.diffs : null;
          var turnKey = data.turn === undefined ? '' : String(data.turn);
          if (hunks && hunks.length) {
            for (var hk = 0; hk < hunks.length; hk++) {
              var h = hunks[hk];
              if (!h || typeof h.path !== 'string' || typeof h.newText !== 'string') continue;
              changes.push({
                key: ev.seq + ':' + hk, seq: ev.seq, time: ev.time, turn: turnKey,
                tool: (ci && ci.name) || '', path: h.path, kind: 'hunk',
                before: typeof h.oldText === 'string' ? h.oldText : null,
                after: h.newText,
              });
            }
          } else if (ci && ci.name === 'write' && ci.args && typeof ci.args.content === 'string') {
            // write 且 meta.diffs 为空 → 两种可能：新建文件，或"内容没变"的整文件覆写。
            // 事件里没有 operation 字段（结果文本是 <path>/<type>/<content> 结构块，不是
            // formatWriteOutput 的 Created/Updated 文案）→ 标记成 'write'，由上层用
            // host /stat 的 birthMs 与本次调用时间比对来判定，别在这儿瞎猜（猜错会误删既有文件）
            var wpath = ci.args.file_path || ci.args.path;
            if (typeof wpath === 'string' && wpath) {
              changes.push({
                key: ev.seq + ':write', seq: ev.seq, time: ev.time, turn: turnKey,
                tool: 'write', path: wpath, kind: 'write', before: null, after: ci.args.content,
              });
            }
          }
        }
      }
      var partial = null;
      if (liveText || liveReason) {
        var pb = [];
        if (liveReason) pb.push({ kind: 'reasoning', text: liveReason });
        if (liveText) pb.push({ kind: 'text', text: liveText });
        partial = { blocks: pb };
      }
      // 正在跑的工具（有 call 没 result 的最后一个）
      var runningTool = null;
      for (var cid in pendingCalls) { if (pendingCalls[cid]) runningTool = pendingCalls[cid]; }
      return {
        nodes: nodes,
        changes: changes,
        partial: partial,
        openState: (snap && snap.openState) || 'open',
        running: !!(snap && snap.running),
        hasMore: !!(win && win.hasMore),
        progress: {
          step: progStep,
          turn: progTurn,
          turnStart: progTurnStart || progFirstTime || 0,
          tool: runningTool,
          tools: toolCount,
          lastTurnEnd: lastTurnEnd,
        },
      };
    }

    // 改动行数估算（清单徽标用）：按行多重集差集，不做 LCS（大文件也不卡）
    function lineCounts(before, after) {
      var oldLines = typeof before === 'string' && before ? before.split('\n') : [];
      var newLines = typeof after === 'string' && after ? after.split('\n') : [];
      var i, c;
      var oldMap = {};
      for (i = 0; i < oldLines.length; i++) oldMap[oldLines[i]] = (oldMap[oldLines[i]] || 0) + 1;
      var added = 0;
      for (i = 0; i < newLines.length; i++) {
        c = oldMap[newLines[i]] || 0;
        if (c > 0) oldMap[newLines[i]] = c - 1; else added += 1;
      }
      var newMap = {};
      for (i = 0; i < newLines.length; i++) newMap[newLines[i]] = (newMap[newLines[i]] || 0) + 1;
      var removed = 0;
      for (i = 0; i < oldLines.length; i++) {
        c = newMap[oldLines[i]] || 0;
        if (c > 0) newMap[oldLines[i]] = c - 1; else removed += 1;
      }
      return { added: added, removed: removed };
    }

    function AgentPanel(props) {
      var listState = props.listState, current = props.current, conv = props.conv,
        sessionFace = props.sessionFace, onSelectSession = props.onSelectSession,
        onSend = props.onSend, onCancel = props.onCancel, onNewSession = props.onNewSession,
        rounds = props.rounds || [], pendingGroups = props.pendingGroups || [], allGroups = props.allGroups || [],
        historyOpen = !!props.historyOpen, hasMoreChanges = !!props.hasMoreChanges,
        sessionsOpen = !!props.sessionsOpen,
        sesSearch = props.sesSearch || { q: '', items: null, hasMore: false, busy: false },
        onSessionSearch = props.onSessionSearch, onToggleSessions = props.onToggleSessions,
        onReviewGroups = props.onReviewGroups, onToggleHistory = props.onToggleHistory,
        onRollbackChange = props.onRollbackChange, onKeepGroups = props.onKeepGroups,
        onUndoGroups = props.onUndoGroups, onKeepAll = props.onKeepAll, onUndoAll = props.onUndoAll;
      var draftState = React.useState('');
      var draft = draftState[0], setDraft = draftState[1];
      var scrollRef = React.useRef(null);
      var stickRef = React.useRef(true);

      React.useEffect(function () {
        var el = scrollRef.current;
        if (el && stickRef.current) el.scrollTop = el.scrollHeight;
      }, [conv]);

      function onScroll(e) {
        var el = e.target;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }

      function send() {
        var text = draft.trim();
        if (!text || !sessionFace) return;
        onSend(text);
        setDraft('');
      }

      function onKeyDown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      }

      // ── 会话列表 ──
      var sessionRows = [];
      if (listState) {
        for (var i = 0; i < listState.ids.length; i++) {
          var id = listState.ids[i];
          var summary = listState.byId[id];
          if (!summary || summary.blank) continue;
          // 子代理会话（Agent 派出去干活的内部会话）**不成行** —— 与平台自己的侧栏同一判据。
          // 列出来的后果：点开必报 session/agent-busy，因为它只能用"父会话地址"打开，而列表点击只给 id
          //（平台校验见 api/session-controller 的 validateAddress：origin 是 subagent 就拒 kind:'session'）。
          if (summary.origin === 'subagent') continue;
          // IIFE 固定循环变量：var id 是函数作用域，直接闭包会让所有行
          // 点击都选最后一个会话（2026-09-02 stale-loop 修复）
          (function (sid) {
            sessionRows.push(h('div', {
              key: sid,
              className: 'dside-session' + (sid === current ? ' on' : ''),
              onClick: function () { onSelectSession(sid); },
              title: sid,
            },
              h('span', { className: 'dside-session-dot ' + (summary.running ? 'running' : 'idle') }),
              h('span', { className: 'dside-session-title' }, shortTitle(summary)),
              h('span', { className: 'dside-session-time' }, formatWhen(summary.updatedAt)),
            ));
          })(id);
        }
      }
      var sessionsBlock = null;
      if (sessionsOpen) {
        // 命中片段：以查询词为中心截取，**头尾都加省略号**（像全局搜代码那样），
        // 并把区间内**每一处命中标绿**（用平台 token state-success-primary/tertiary，
        // 随明暗主题自动换色，不硬编码色值 —— 见 CSS 的 .dside-hit）。
        var snippetOf = function (text, q) {
          var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
          var query = String(q == null ? '' : q).trim();
          if (!t) return '';
          if (!query) return t.length > 110 ? t.slice(0, 110) + '…' : t;
          var ql = query.toLowerCase();
          var i = t.toLowerCase().indexOf(ql);
          if (i < 0) return t.length > 110 ? t.slice(0, 110) + '…' : t;
          var start = Math.max(0, i - 30);
          var end = Math.min(t.length, i + query.length + 80);
          var seg = t.slice(start, end);
          var segLower = seg.toLowerCase();
          var out = [];
          if (start > 0) out.push('…');
          var pos = 0;
          for (;;) {
            var k = segLower.indexOf(ql, pos);
            if (k < 0) break;
            if (k > pos) out.push(seg.slice(pos, k));
            out.push(h('span', { className: 'dside-hit', key: 'hit' + k }, seg.slice(k, k + query.length)));
            pos = k + query.length;
          }
          if (pos < seg.length) out.push(seg.slice(pos));
          if (end < t.length) out.push('…');
          return out;
        };
        var sesQuery = sesSearch.q || '';
        var searching = !!sesQuery.trim();
        var listBody;
        if (searching) {
          var items = sesSearch.items;
          // 搜索命中来自 host 侧的会话日志扫描，**不带来源字段** → 借平台列表判来源，把子代理会话挡掉：
          // 不然它们会从搜索这条路漏出来，点开照样报 session/agent-busy（理由同上面列表那一处）。
          if (Array.isArray(items)) {
            items = items.filter(function (it) {
              var s0 = listState && listState.byId ? listState.byId[it.sessionId] : null;
              return !(s0 && s0.origin === 'subagent');
            });
          }
          if (sesSearch.busy || items === null) {
            listBody = h('div', { className: 'dside-session-empty' }, '搜索中…');
          } else if (!items.length) {
            listBody = h('div', { className: 'dside-session-empty' }, '没有匹配的对话');
          } else {
            listBody = items.map(function (it) {
              var sum = listState && listState.byId ? listState.byId[it.sessionId] : null;
              var title = sum ? shortTitle(sum) : it.sessionId;
              return h('div', {
                key: it.sessionId,
                className: 'dside-session res' + (it.sessionId === current ? ' on' : ''),
                title: title + '\n' + String(it.snippet || ''),
                onClick: function () { onSelectSession(it.sessionId); },
              },
                h('span', { className: 'dside-session-title' }, title),
                h('span', { className: 'dside-session-snippet' }, snippetOf(it.snippet, sesQuery)),
              );
            });
            if (sesSearch.hasMore) listBody.push(h('div', { key: 'more', className: 'dside-session-empty' }, '还有更多匹配，输入更具体的关键词'));
          }
        } else {
          listBody = sessionRows.length ? sessionRows : h('div', { className: 'dside-session-empty' }, '暂无历史对话');
        }
        sessionsBlock = h('div', { className: 'dside-sessions' },
          h('div', { className: 'dside-sessions-head' },
            h('input', {
              className: 'dside-sessions-search',
              placeholder: '搜索历史对话…',
              value: sesQuery,
              onChange: function (e) { onSessionSearch(e.target.value); },
            }),
            h('button', { className: 'link', title: '收起历史对话', onClick: onToggleSessions }, '收起'),
          ),
          listBody,
        );
      }

      // ── 消息区 ──
      var body;
      var msgs = [];
      if (conv) {
        var nodes = conv.nodes || [];
        for (var j = 0; j < nodes.length; j++) {
          var n = nodes[j];
          if (n.kind === 'user') {
            msgs.push(h('div', { className: 'dside-msg user', key: 'u' + n.seq },
              textOfContent(n.content),
              h('span', { className: 'dside-msg-time' }, formatTime(n.time)),
            ));
          } else if (n.kind === 'assistant') {
            msgs.push(h(AssistantBubble, { key: 'a' + n.seq, node: n }));
          } else if (n.kind === 'tool-result' || n.kind === 'command') {
            msgs.push(h(ToolRow, { key: 't' + n.seq, node: n }));
          }
          // context/steering/model-retry/turn-error/compaction/unknown：不渲染（官方已过滤系统注入）
        }
        if (conv.hasMore) msgs.unshift(h('button', {
          key: 'older',
          className: 'dside-btn small dside-older',
          onClick: function () { if (sessionFace && sessionFace.loadOlder) sessionFace.loadOlder(); },
        }, '↑ 加载更早的消息'));
        if (conv.partial) msgs.push(h(AssistantBubble, { key: 'partial', partial: conv.partial }));
        if (msgs.length === 0) {
          body = h('div', { className: 'dside-agent-empty' },
            conv.openState === 'loading' ? '加载历史中…' : '暂无消息，在下方输入框向 Agent 提问');
        } else {
          body = msgs;
        }
      } else {
        body = h('div', { className: 'dside-agent-empty' }, '加载中…');
      }

      var running = !!(conv && conv.running);
      // ⑭ 长任务进度：跑的时候每秒 tick 一次算"已用时间"；徽标与进度条都读这里
      var progress = (conv && conv.progress) || null;
      var nowState = React.useState(Date.now());
      var nowMs = nowState[0], setNowMs = nowState[1];
      React.useEffect(function () {
        if (!running) return undefined;
        var t = setInterval(function () { setNowMs(Date.now()); }, 1000);
        return function () { clearInterval(t); };
      }, [running]);
      var fmtDur = function (ms) {
        if (!ms || ms < 0) return '0:00';
        var s = Math.floor(ms / 1000);
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      };
      var elapsed = progress && progress.turnStart ? Math.max(0, nowMs - progress.turnStart) : 0;
      var lastEnd = progress && progress.lastTurnEnd;
      var lastAborted = !!(lastEnd && lastEnd.reason && lastEnd.reason.kind === 'aborted');
      var lastDur = lastEnd && progress && progress.turnStart ? Math.max(0, lastEnd.time - progress.turnStart) : 0;
      var inputDisabled = !sessionFace || !conv || conv.openState === 'loading' || conv.openState === 'error' || conv.removed;

      // ── ⑥ 第二/三刀：改动清单（Agent 改了哪些文件 → 逐个看 / 撤销）──
      // 交互按主流 IDE 的习惯（2026-09-17 用户反馈后重做）：
      //   · 它是「待处理队列」，不是常驻面板 —— 待处理的改动全部处理完，整块直接消失；
      //   · 文件行本身就是入口（点行 = 看这个文件的差异），不再放多余的「审阅」按钮；
      //   · 「历史 N 轮」是"主动回看已处理内容"的唯一入口（命令面板里也有一条，面板消失后仍可达）。
      var changesBlock = null;
      var totalGroups = allGroups.length;
      // 待处理集合由外层算好（跨轮合并后的队列）；折叠态只列它，不再"只看最近一轮"
      var pend = pendingGroups;
      if (totalGroups) {
        function changeRow(g, idx, queue, showRound) {
          // 行数按每一处改动各自算再累加（跨轮合并后 before/after 是拼起来的片段，直接整段比会失真）
          var counts = { added: 0, removed: 0 };
          if (g.entries && g.entries.length) {
            for (var ci = 0; ci < g.entries.length; ci++) {
              var cc = lineCounts(g.entries[ci].before, g.entries[ci].after);
              counts.added += cc.added; counts.removed += cc.removed;
            }
          } else {
            counts = lineCounts(g.before, g.after);
          }
          return h('div', {
            key: g.key,
            className: 'dside-change',
            title: g.path + '（点击查看差异）',
            onClick: function () { onReviewGroups(queue || [g], idx || 0); },
          },
            h('span', { className: 'dside-change-icon' }, g.isCreate ? '＋' : '✎'),
            h('span', { className: 'dside-change-name' }, g.name),
            h('span', { className: 'dside-change-diff' },
              counts.added ? h('span', { className: 'add' }, '+' + counts.added) : null,
              counts.removed ? h('span', { className: 'del' }, '−' + counts.removed) : null,
            ),
            // 跨轮的条目标出来源（"第 2–3 轮"）：不然用户不知道这一行里压着两轮没处理的改动
            showRound && g.rounds && g.rounds.length > 1
              ? h('span', { className: 'dside-change-tag' }, '第 ' + g.rounds[0] + '–' + g.rounds[g.rounds.length - 1] + ' 轮')
              : null,
            // 行尾两个动作（鼠标移上去才显形，VSCode 的改动列表同款）：
            // ✓ = 这份改动认了；↺ = 还原回去。
            // ⚠ 这里**不显示**"已保留/已撤销""3/5"这类自造状态 —— 处理完的行直接退场，不留句尾（2026-10-10 重做）。
            h('span', { className: 'dside-change-acts' },
              h('button', {
                className: 'dside-btn small',
                title: '保留这个文件的改动',
                onClick: function (e) { e.stopPropagation(); onKeepGroups([g], g.name); },
              }, '✓'),
              h('button', {
                className: 'dside-btn small danger',
                title: g.isCreate ? '删除这个新建的文件' : '把这些改动还原回去',
                onClick: function (e) { e.stopPropagation(); onRollbackChange(g); },   // 别顺带把差异打开
              }, '↺'),
            ),
          );
        }

        function roundHead(r) {
          return h('div', { className: 'dside-round' + (r.isCurrent ? ' now' : ''), key: 'round-' + r.turn },
            h('b', null, '第 ' + r.ordinal + ' 轮'),
            h('span', null, r.groups.length + ' 个文件'),
            r.isCurrent ? h('span', { className: 'dside-change-tag' }, '本轮') : null,
            h('span', { className: 'sp' }),
            h('button', {
              className: 'dside-btn small',
              title: '撤销这一轮的全部改动',
              onClick: function () { onUndoGroups(r.groups, '第 ' + r.ordinal + ' 轮'); },
            }, '↺'),
            h('button', {
              className: 'dside-btn small',
              title: '保留这一轮的改动',
              onClick: function () { onKeepGroups(r.groups, '第 ' + r.ordinal + ' 轮'); },
            }, '保留'),
          );
        }

        // 折叠态列的是"跨轮合并后的待处理队列"；一条都不剩就整块不渲染（历史视图除外 —— 那是用户主动打开的）
        if (historyOpen || pend.length) {
          var headEl, rows = [], i;
          if (historyOpen) {
            headEl = h('div', { className: 'dside-changes-head' },
              h('b', null, '本次会话改动 ' + totalGroups + ' 处'),
              h('span', null, rounds.length + ' 轮'),
              h('span', { className: 'sp' }),
              h('button', { className: 'dside-btn small', onClick: onKeepAll }, '全部保留'),
              h('button', { className: 'dside-btn small danger', onClick: onUndoAll }, '全部撤销'),
              h('button', { className: 'link', onClick: onToggleHistory }, '收起'),
            );
            for (i = 0; i < rounds.length; i++) {
              rows.push(roundHead(rounds[i]));
              for (var j = 0; j < rounds[i].groups.length; j++) {
                rows.push(changeRow(rounds[i].groups[j], j, rounds[i].groups));
              }
            }
          } else {
            headEl = h('div', { className: 'dside-changes-head' },
              h('b', null, '待处理 ' + pend.length + ' 项'),
              h('span', { className: 'sp' }),
              h('button', { className: 'dside-btn small primary', onClick: onKeepAll }, '全部保留'),
              h('button', { className: 'dside-btn small danger', onClick: onUndoAll }, '全部撤销'),
              rounds.length > 1
                ? h('button', { className: 'link', onClick: onToggleHistory }, '历史 ' + rounds.length + ' 轮')
                : null,
            );
            for (i = 0; i < pend.length; i++) rows.push(changeRow(pend[i], i, pend, true));
          }
          changesBlock = h('div', { className: 'dside-changes' }, headEl, rows,
            historyOpen && hasMoreChanges
              ? h('div', { className: 'dside-changes-note' }, '↑ 更早的改动还没加载（点上方「加载更早的消息」）')
              : null);
        }
      }

      // 平台会话挂进来之后，清一遍"在天工没用/点不动"的平台 chrome（整个会话头 + 右栏开关），
      // 并跟随其重渲染
      var platRef = React.useRef(null);
      React.useEffect(function () {
        var host = platRef.current;
        if (!host) return;
        hidePlatformChrome(host);
        var mo = null;
        try {
          mo = new MutationObserver(function () { hidePlatformChrome(host); });
          mo.observe(host, { childList: true, subtree: true });
        } catch (e) { /* 观察失败不影响使用 */ }
        return function () { if (mo) { try { mo.disconnect() } catch (e) { /* 忽略 */ } } };
      }, []);

      // 右侧面板 = 自绘的会话列表 + 改动清单/进度（天工自己的东西）
      //          + **平台原生会话**（消息、工具卡、审批卡、提问卡片、输入框全在里面）
      // 2026-09-20：不再自绘对话与输入框 —— 平台那套是完整的，自绘只会漏（提问卡片就是这么漏掉的）。
      return h('div', { className: 'dside-agent-wrap' },
        sessionsBlock,
        changesBlock,
        running
          ? h('div', { className: 'dside-agent-progress' },
              h('span', { className: 'sp' }, '第 ' + ((progress && progress.step) || 0) + ' 步 · 已用 ' + fmtDur(elapsed)),
              h('span', { className: 'what' },
                progress && progress.tool ? ('正在调用 ' + progress.tool + '…') : '等待模型响应…'),
              h('span', { className: 'hint' }, '点下方 ⏹ 可中断'),
            )
          : null,
        h('div', { className: 'dside-agent-platform', ref: platRef },
          props.renderSlot
            ? props.renderSlot('main', {}, { entryKey: 'conversation' })
            : h('div', { className: 'dside-agent-empty' },
                '会话槽不可用：root 的子槽没有声明（检查 profile 里 ui-layout 的 frame:false 与 dsh-ide 的 children）'),
        ),
      );
    }

    // ── 插件面板：全量透明（2026-09-22 用户要求）──────────────────────────────
    // 用户原话："后端那一大批插件也要在这里显示，万一我以后要针对后端插件进行改动呢？
    //   其它什么不可见的统统都要显示，这些东西必须对我透明的，我他妈是软件的开发者，隐藏干嘛。"
    // 所以三块，一条都不藏：
    //   ① 插件树（host 半的真身 ctx.loader.entries()）：**含纯后端插件、含 disabled 的行**，
    //      每条带 状态 / 是否另带前端半 / 来源组 / 包名与版本 / package.json 说明；
    //   ② 前端 bundle（浏览器侧模块表）：rev / 启动或按需 / inject 数（这层决定页面里跑到的是哪份代码）；
    //   ③ 动态插件（会话内 Agent 造的，可停/运行/删）。
    var PLUGIN_STATE_LABEL = {
      active: { text: '运行中', cls: 'run' },
      loading: { text: '加载中', cls: 'pending' },
      pending: { text: '等待服务', cls: 'pending' },
      failed: { text: '失败', cls: 'failed' },
      unloaded: { text: '未加载', cls: 'stop' },
      disabled: { text: '已停用', cls: 'disabled' },
    };
    function pluginStateBadge(state) {
      var l = PLUGIN_STATE_LABEL[state] || { text: String(state || '未知'), cls: 'stop' };
      return h('span', { className: 'dside-plugin-badge ' + l.cls }, l.text);
    }

    function PluginPanel(props) {
      var plugins = props.plugins || {}, onAction = props.onAction, busy = props.busy;
      var allRows = plugins.rows || [];
      var formal = plugins.formal || [];
      var dynamic = plugins.dynamic || [];
      var qs = React.useState('');
      var q = qs[0], setQ = qs[1];
      var ms = React.useState('all');
      var mode = ms[0], setMode = ms[1];

      var countClient = allRows.filter(function (r) { return r.hasClient; }).length;
      var countDisabled = allRows.filter(function (r) { return r.disabled; }).length;
      var countHostOnly = allRows.length - countClient;
      var needle = q.trim().toLowerCase();
      function hit(text) { return !needle || String(text || '').toLowerCase().indexOf(needle) >= 0; }
      var rows = allRows.filter(function (r) {
        if (mode === 'client' && !r.hasClient) return false;
        if (mode === 'host' && r.hasClient) return false;
        if (mode === 'disabled' && !r.disabled) return false;
        return hit(r.id) || hit(r.name) || hit(r.description) || hit(r.group);
      });
      var clientRows = formal.filter(function (p) { return hit(p.id); });

      var sections = [];
      // 过滤条（清单一百多条，不给筛选等于不可用）
      sections.push(h('div', { className: 'dside-plugin-filter', key: 'filter' },
        h('input', {
          className: 'dside-plugin-search',
          value: q,
          placeholder: '搜插件 id / 包名 / 说明',
          onChange: function (e) { setQ(e.target.value); },
        }),
        h('div', { className: 'dside-plugin-modes' },
          [['all', '全部 ' + allRows.length], ['client', '带前端 ' + countClient],
            ['host', '纯后端 ' + countHostOnly], ['disabled', '已停用 ' + countDisabled]]
            .map(function (pair) {
              return h('button', {
                key: 'm:' + pair[0],
                className: 'dside-plugin-mode' + (mode === pair[0] ? ' on' : ''),
                onClick: function () { setMode(pair[0]); },
              }, pair[1]);
            }))));

      // ① 插件树（后端装配的真身，含停用的行）
      sections.push(h('div', { className: 'dside-pane-title', key: 'rows-title' },
        '插件树 · 后端装配 (' + rows.length + '/' + allRows.length + ')'));
      if (rows.length === 0) {
        sections.push(h('div', { className: 'dside-agent-empty', key: 'rows-empty' }, '没有匹配的插件'));
      }
      rows.forEach(function (r) {
        var meta = [];
        if (r.name && r.name !== r.id) meta.push('包 ' + r.name);
        if (r.version) meta.push('v' + r.version);
        if (r.group) meta.push('来源 ' + r.group);
        meta.push(r.hasClient
          ? ('前端 rev ' + String(r.clientRev || '').slice(0, 8) + ' · ' + (r.clientImmediately ? '启动加载' : '按需加载') + (r.clientInject ? ' · inject ' + r.clientInject : ''))
          : '纯后端（无前端半）');
        sections.push(h('div', {
          className: 'dside-plugin' + (r.disabled ? ' off' : ''),
          key: 'r:' + r.id,
          'data-plugin-row': r.id,
        },
          h('div', { className: 'dside-plugin-head' },
            h('span', { className: 'dside-plugin-name' }, r.id),
            pluginStateBadge(r.state),
            r.hasClient ? h('span', { className: 'dside-plugin-badge client' }, '前端') : null,
          ),
          r.description ? h('div', { className: 'dside-plugin-purpose' }, r.description) : null,
          h('div', { className: 'dside-plugin-meta' }, meta.join(' · ')),
        ));
      });

      // ② 前端 bundle（浏览器侧模块表：页面里真正跑到的那份代码）
      sections.push(h('div', { className: 'dside-pane-title', key: 'formal-title' },
        '前端 bundle · 浏览器侧模块表 (' + clientRows.length + '/' + formal.length + ')'));
      clientRows.forEach(function (p) {
        sections.push(h('div', { className: 'dside-plugin', key: 'f:' + p.id, 'data-client-row': p.id },
          h('div', { className: 'dside-plugin-head' },
            h('span', { className: 'dside-plugin-name' }, p.id),
            h('span', { className: 'dside-plugin-badge formal' }, '内置'),
          ),
          h('div', { className: 'dside-plugin-meta' },
            'rev ' + String(p.rev || '').slice(0, 8)
            + (p.immediately ? ' · 启动加载' : ' · 按需加载')
            + (Array.isArray(p.inject) && p.inject.length > 0 ? ' · inject ' + p.inject.length : '')),
        ));
      });

      // ③ 动态插件（会话内产物）
      sections.push(h('div', { className: 'dside-pane-title', key: 'dyn-title' }, '动态插件 (' + dynamic.length + ')'));
      if (dynamic.length === 0) {
        sections.push(h('div', { className: 'dside-agent-empty', key: 'dyn-empty' },
          '暂无动态插件。动态插件由 Agent 在会话中创建（应用内的开发产物）。',
        ));
      }
      dynamic.forEach(function (p) {
        var latest = p.latestRun;
        var running = latest && (latest.status === 'running' || latest.status === 'waiting' || latest.status === 'client-pending');
        var stopped = latest && (latest.status === 'stopped' || latest.status === 'rejected');
        var pkg = p.packages.length > 0 ? p.packages[p.packages.length - 1] : undefined;
        sections.push(h('div', { className: 'dside-plugin', key: 'd:' + p.pluginId },
          h('div', { className: 'dside-plugin-head' },
            h('span', { className: 'dside-plugin-name' }, p.pluginId),
            h('span', { className: 'dside-plugin-badge ' + (running ? 'run' : 'stop') },
              latest ? latest.status : '未运行',
            ),
          ),
          pkg ? h('div', { className: 'dside-plugin-purpose' }, pkg.name + ' — ' + pkg.purpose) : null,
          h('div', { className: 'dside-plugin-meta' },
            '包: ' + p.packages.map(function (d) { return d.packageId; }).join(', ') +
            (p.currentPackageId ? ' · 当前: ' + p.currentPackageId : ''),
          ),
          h('div', { className: 'dside-plugin-actions' },
            running
              ? h('button', { className: 'dside-btn small', disabled: busy, onClick: function () { onAction('stop', p.pluginId); } }, '停止')
              : h('button', { className: 'dside-btn small primary', disabled: busy, onClick: function () { onAction('run', p.pluginId); } }, '运行'),
            h('button', { className: 'dside-btn small danger', disabled: busy, onClick: function () { onAction('remove', p.pluginId); } }, '删除'),
          ),
        ));
      });

      return h('div', { className: 'dside-plugins' }, sections);
    }

    // 把平台内容（官方右栏那类）直接渲染在我们外壳里时的一道保险：渲染期抛错会顺着 root 槽
    // 把整个界面带崩（2026-10-10 白屏事故同款，且平台错误边界会吞掉堆栈），所以必须躲在这里面。
    // 2026-10-12 备：路二（外壳自建、内容贴官方）后续往外壳里塞平台内容时统一用它。
    class SlotErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) { return { error: error }; }
      componentDidCatch(error, info) {
        trace('ui', 'error', 'slot-render-crashed', {
          slot: (this.props && this.props.name) || '',
          error: String((error && error.message) || error),
          stack: String((error && error.stack) || '').slice(0, 800),
          componentStack: String((info && info.componentStack) || '').slice(0, 800),
        });
      }
      render() {
        if (this.state.error) {
          return h('div', { className: 'dside-slot-fallback' },
            (this.props && this.props.fallback) || '这块内容暂时显示不了');
        }
        return this.props.children;
      }
    }

    function IdeApp(props) {
      var workspaces = props.workspaces;
      var sessions = props.sessions;
      var uiWorkspace = props.uiWorkspace;
      var uiSession = props.uiSession;
      var open = React.useState(true);
      var rootState = React.useState(null);
      var root = rootState[0], setRoot = rootState[1];
      // 对话回退：待回退状态与第二段确认弹窗都放模块级（关软件即丢，正是口径要的）⇒ 这里订阅它们，
      // 弹窗与「已恢复到检查点」那条才会跟着变。
      var rewindTick = React.useState(0);
      React.useEffect(function () {
        return rewindSubscribe(function () { rewindTick[1](function (v) { return v + 1 }) });
      }, []);
      var tabsState = React.useState(function () {
        // 深链支持：?file=D:\path\to\file.ext 启动即打开该文件（作为第一个标签）
        try {
          var p = new URLSearchParams(window.location.search).get('file');
          if (p) return [{ name: p.split(/[\\/]/).pop() || p, path: p, dirty: false }];
        } catch (e) { /* 无参数 */ }
        return [];
      });
      var tabs = tabsState[0], setTabs = tabsState[1];
      var activePathState = React.useState(function () {
        try {
          var p = new URLSearchParams(window.location.search).get('file');
          if (p) return p;
        } catch (e) { /* 无参数 */ }
        return null;
      });
      var activePath = activePathState[0], setActivePath = activePathState[1];
      // @ 引用的候选源读这份快照（渲染期同步；当前激活的排第一）
      syncMentionOpenFiles(tabs, activePath, root);
      var editorBridgeRef = React.useRef(null);
      var overlayState = React.useState(null);   // null | 'commands' | 'files'（③ 面板）
      var overlay = overlayState[0], setOverlay = overlayState[1];
      var searchOpenState = React.useState(false); // ③ 全局搜索面板
      var searchOpen = searchOpenState[0], setSearchOpen = searchOpenState[1];
      var gotoReqState = React.useState(null);   // {seq,path,line,col}（③ 跳转意图）
      var gotoReq = gotoReqState[0], setGotoReq = gotoReqState[1];
      var gotoSeqRef = React.useRef(0);
      var prevFocusRef = React.useRef(null);     // 面板打开前的焦点（关闭后归还）
      var refreshTickState = React.useState(0);
      var refreshTick = refreshTickState[0], setRefreshTick = refreshTickState[1];
      // 资源管理器：当前聚焦的树节点（Ctrl+N 按"当前层级"新建要用它）· 内联新建行 · 折叠计数
      var treeSelState = React.useState(null);       // {path,name,type} | null
      var treeSel = treeSelState[0], setTreeSel = treeSelState[1];
      var inlineNewState = React.useState(null);     // {dir, kind} | null
      var inlineNew = inlineNewState[0], setInlineNew = inlineNewState[1];
      var collapseTickState = React.useState(0);
      var collapseTick = collapseTickState[0], setCollapseTick = collapseTickState[1];
      var fsRevState = React.useState(0);              // 资源管理器自动刷新：host /fs-rev 变了就 +1
      var fsRev = fsRevState[0], setFsRev = fsRevState[1];
      var probCountsState = React.useState({ e: 0, w: 0 });   // ⑤ 状态栏诊断计数（2s 轮询 markers）
      var probCounts = probCountsState[0], setProbCounts = probCountsState[1];
      // 反悔药：最近一份快照的时间（状态栏入口）+ 刷新计数
      var snapTickState = React.useState(0);
      var snapTick = snapTickState[0], setSnapTick = snapTickState[1];
      var snapLastState = React.useState(null);
      var snapLast = snapLastState[0], setSnapLast = snapLastState[1];

      // 快照状态刷新：挂载 / 切工作空间 / 新快照 / 还原之后
      React.useEffect(function () {
        var alive = true;
        apiGet('/snapshots').then(function (r) {
          if (!alive) return;
          var it = r && r.items && r.items[0];
          setSnapLast(it ? it.ts : null);
        });
        return function () { alive = false; };
      }, [snapTick, root]);

      // 自动快照（snapAuto）落盘后由 module 层广播事件 → 刷新状态栏那个时间
      React.useEffect(function () {
        function onSnap() { setSnapTick(function (n) { return n + 1; }); }
        window.addEventListener('dside-snapshot', onSnap);
        return function () { window.removeEventListener('dside-snapshot', onSnap); };
      }, []);

      // 兜底网：每 5 分钟自动存一份（覆盖"完全不经过 Agent 的手工改动"）。
      // host 侧在内容没变时不落新快照，所以历史里只留"真正不同的状态"，不会灌水。
      React.useEffect(function () {
        var t = setInterval(function () { if (!document.hidden) snapAuto('定时快照'); }, 5 * 60 * 1000);
        return function () { clearInterval(t); };
      }, []);
      var treeMenuState = React.useState(null);      // ⑫ 文件树右键菜单 {x,y,node}
      var treeMenu = treeMenuState[0], setTreeMenu = treeMenuState[1];
      var tabMenuState = React.useState(null);       // ⑮ 标签右键菜单 {x,y,path}
      var tabMenu = tabMenuState[0], setTabMenu = tabMenuState[1];
      // ⑮ 标签三件套偏好（预览模式总开关 / 快速打开走预览 / 代码跳转走预览）
      var tabPrefsState = React.useState(readTabPrefs);
      var tabPrefs = tabPrefsState[0], setTabPrefs = tabPrefsState[1];
      function updateTabPrefs(patch) {
        var next = {};
        var key;
        for (key in tabPrefs) next[key] = tabPrefs[key];
        for (key in patch) next[key] = patch[key];
        writeTabPrefs(next);
        setTabPrefs(next);
        trace('ui', 'info', 'tab-prefs-change', patch);
      }
      var nameDialogState = React.useState(null);    // ⑫ 命名对话框 {title,initial,placeholder,hint,onSubmit}
      var nameDialog = nameDialogState[0], setNameDialog = nameDialogState[1];
      // 键位（2026-09-21）：keysRev 一变，全局路由与编辑器绑定一起重算
      var keysRevState = React.useState(0);
      var keysRev = keysRevState[0], setKeysRev = keysRevState[1];
      // 中面板视图：'editor'（默认）| 'keys'（快捷键设置）
      var centerViewState = React.useState('editor');
      var centerView = centerViewState[0], setCenterView = centerViewState[1];
      // 设置类页面统一走「中栏标签」（2026-10-12 用户口径：按钮归我们、内容在中栏标签里展示）。
      // 不再用 centerView 那套"盖一层视图"——那没有标签栏，关不掉也切不走。
      function openSettingsTab(page) {
        setOverlay(null); setSearchOpen(false);
        openTab({ name: SETTINGS_TAB_TITLE[page] || '设置', path: SETTINGS_SCHEME + page });
        trace('ui', 'info', 'settings-tab-open', { page: page });
      }
      function openKeybindings() { openSettingsTab('keys'); }
      function openEditorSettings() { openSettingsTab('editor-prefs'); }
      function openAgentSettings() { openSettingsTab('agent'); }
      // ── Markdown 文档预览（2026-10-14，用户拍板"目录走页内目录"）─────────────
      // 预览状态记在**标签自己身上**（mdPreview）：语义是"这个标签现在显示源码还是预览"，
      // 不是"另开了一个预览标签"（VSCode 的 markdown.togglePreview 也是原地翻面）。
      function setTabMdPreview(path, on) {
        setTabs(function (prev) {
          var at = findTabIndex(prev, path);
          if (at < 0 || !!prev[at].mdPreview === !!on) return prev;
          var out = prev.slice();
          out[at] = tabItem(prev[at], { mdPreview: !!on });
          return out;
        });
      }
      function activeTabItem() {
        for (var i = 0; i < tabs.length; i++) if (tabs[i].path === activePath) return tabs[i];
        return null;
      }
      function toggleMdPreview() {
        var t = activeTabItem();
        if (!t || isPseudoPath(t.path) || !isMarkdownName(t.name)) {
          setStatusText('当前标签不是 Markdown 文件（.md / .markdown）');
          return;
        }
        var on = !t.mdPreview;
        setTabMdPreview(t.path, on);
        setStatusText((on ? 'Markdown 预览：' : 'Markdown 源码：') + t.name);
        trace('ui', 'info', 'md-preview-toggle', { path: t.path, on: on });
      }
      // 文件树右键「打开预览」走这条路：先按普通方式开标签，再把那个标签翻成预览
      function openMarkdownPreview(path, name) {
        if (!path) return;
        openTab({ name: name || String(path).split('\\').pop(), path: path });
        setTabMdPreview(path, true);
        setCenterView('editor');
        trace('ui', 'info', 'md-preview-open', { path: path });
      }
      var termOpenState = React.useState(false);     // ⑬ 集成终端面板（Ctrl+`）
      var termOpen = termOpenState[0], setTermOpen = termOpenState[1];
      // 中下方面板里的当前标签：'term' 终端 / 'keys' Agent键盘映射（第三期）。
      // 状态放这一层的原因：Agent 打字时要不要"闪点提醒"得由这里判断（面板关着 / 停在终端页）。
      var termPaneState = React.useState('term');
      var termPane = termPaneState[0], setTermPane = termPaneState[1];
      // Agent 键盘记账（第三期）：held = 正被按住的键，recent = 最近按键流，flash = 有事发生但没看着那一页
      var kbState = React.useState({ held: {}, recent: [], flash: false });
      var kb = kbState[0], setKb = kbState[1];
      var kbFlashTimerRef = React.useRef(null);
      // 壳事件订阅是在挂载时捕获回调的，用 ref 保证它永远指向最新那版 kbApply（函数声明会提升，这里先赋再用没问题）
      var kbApplyRef = React.useRef(null);
      kbApplyRef.current = kbApply;
      var kbRef = React.useRef(kb);
      kbRef.current = kb;
      // 自检钩子（同 window.__dsideKeys / __dshTraceStat 那套）：只读状态 + 一个"喂数据"入口。
      // 喂数据的入口与壳事件走的是**同一条路**（kbApply）⇒ 探针/回归能验"键帽到底亮没亮"，不必真敲键盘。
      React.useEffect(function () {
        try {
          window.__dsideKB = {
            state: function () {
              return {
                held: kbRef.current.held, recent: kbRef.current.recent.slice(-8), flash: kbRef.current.flash,
                pane: kbPaneRef.current, open: kbTermOpenRef.current,
              };
            },
            feed: function (rec) { kbApplyRef.current(rec); },
          };
        } catch (e) { /* 忽略 */ }
      }, []);
      var kbPaneRef = React.useRef(termPane);      kbPaneRef.current = termPane;
      var kbTermOpenRef = React.useRef(termOpen);  kbTermOpenRef.current = termOpen;
      function kbSwitchPane(p) {
        setTermPane(p === 'keys' ? 'keys' : 'term');
        if (p !== 'keys') return;
        // 点开键盘页 = 看过了 → 立刻把闪点清掉（不然还要等它自己过期）
        if (kbFlashTimerRef.current) { clearTimeout(kbFlashTimerRef.current); kbFlashTimerRef.current = null; }
        setKb(function (prev) { return prev.flash ? { held: prev.held, recent: prev.recent, flash: false } : prev; });
      }
      function kbFlashOn() {
        if (kbFlashTimerRef.current) clearTimeout(kbFlashTimerRef.current);
        setKb(function (prev) { return prev.flash ? prev : { held: prev.held, recent: prev.recent, flash: true }; });
        kbFlashTimerRef.current = setTimeout(function () {
          kbFlashTimerRef.current = null;
          setKb(function (prev) { return prev.flash ? { held: prev.held, recent: prev.recent, flash: false } : prev; });
        }, 1800);
      }
      function kbNeedFlash() {
        // 没看着键盘页时闪点（面板整个关着 → 状态栏那颗终端开关上闪）
        if (kbPaneRef.current !== 'keys' || !kbTermOpenRef.current) kbFlashOn();
      }
      // 一条按键记录到了，面板该怎么现身？（2026-10-08 用户拍板）
      //   面板**关着** → 自动展开并停在键盘页（原设计稿"不自动抢"在这里让步：关着时连标签都不存在，
      //     只闪 8px 小点等于没有提示，用户实测直接看不到）；
      //   面板**开着但停在终端页** → 按设计稿只闪点，不抢用户正在看的终端。
      // ⚠ 一个"键流段"（连续按键、中间没停过 5 秒）只自动弹一次：用户把它关掉 / 切回终端之后，
      //   不会每敲一个键又被拽回来。
      var kbBurstRef = React.useRef(0);
      function kbOnRecord() {
        var now = Date.now();
        var fresh = (now - kbBurstRef.current) > 5000;
        kbBurstRef.current = now;
        if (fresh) {
          // 每次键流开始记一笔：以后"按键到底有没有送到页面"查轨迹就有答案（这次没这行，多绕了一圈）
          trace('ui', 'info', 'browser-key-stream', { pane: kbPaneRef.current, open: kbTermOpenRef.current });
          if (!kbTermOpenRef.current) {
            setTermOpen(true);
            kbSwitchPane('keys');        // 顺手清掉闪点
            trace('ui', 'info', 'browser-key-autoshow', {});
            return;
          }
        }
        kbNeedFlash();
      }
      function kbPush(list, label) {
        var out = list.concat([label]);
        return out.length > 24 ? out.slice(out.length - 24) : out;
      }
      function kbCombo(held, name) {
        var mods = [];
        if (held.Ctrl) mods.push('Ctrl');
        if (held.Alt) mods.push('Alt');
        if (held.Shift) mods.push('Shift');
        if (held.Meta) mods.push('Meta');
        return mods.length ? (mods.join('+') + '+' + name) : name;
      }
      function kbCopyHeld(held) { var out = {}; for (var k in held) out[k] = held[k]; return out; }
      // 驱动层报来的一条动作记录 → 键帽亮/灭 + 按键流。**这是面板唯一的数据入口**
      function kbApply(rec) {
        if (!rec) return;
        if (rec.kind === 'text') {
          // 中文这类敲不出来的字符是"整段写入"，没有键帽可亮 → 只在流里记一笔
          // ⚠ 敏感字段（密码/验证码）壳那边只会给 masked，别在这里把内容补出来
          var kbDesc = rec.masked
            ? ('文本「已打码 · ' + String(rec.length || 0) + ' 个字符」')
            : ('文本「' + String(rec.text || '').slice(0, 12) + '」');
          setKb(function (prev) { return { held: prev.held, recent: kbPush(prev.recent, kbDesc), flash: prev.flash }; });
          kbNeedFlash();
          return;
        }
        if (rec.kind !== 'key') return;
        var name = kbNorm(rec.key);
        if (!name) return;
        var phase = String(rec.phase || 'press');
        setKb(function (prev) {
          var held = kbCopyHeld(prev.held);
          if (phase === 'up') { delete held[name]; return { held: held, recent: prev.recent, flash: prev.flash }; }
          held[name] = true;
          var recent = prev.recent;
          if (phase === 'down') {
            if (!KB_IS_MOD[name]) recent = kbPush(prev.recent, kbCombo(held, name));   // 组合键：Ctrl+A 记成一条
          } else {
            recent = kbPush(prev.recent, name);
          }
          return { held: held, recent: recent, flash: prev.flash };
        });
        if (phase === 'press') {
          // 打字是"单次按键"：亮一下就灭，别留"还按着"的假象
          setTimeout(function () {
            setKb(function (prev) {
              if (!prev.held[name]) return prev;
              var h2 = kbCopyHeld(prev.held);
              delete h2[name];
              return { held: h2, recent: prev.recent, flash: prev.flash };
            });
          }, 150);
        }
        kbOnRecord();
      }
      // ③「在终端中打开」的目标目录（null = 用工作区根）。B 方案：单终端 —— 换目录就换 key 重建。
      var termCwdState = React.useState(null);
      var termCwd = termCwdState[0], setTermCwd = termCwdState[1];
      // 「新建终端」（Ctrl+Shift+`）：单终端模型下没有"再开一个"这回事 → 递增这个计数让 TermPanel 换 key
      // 重挂载（旧 PTY 在它的 cleanup 里 /term-close）。**只由命令显式递增**，不像 root 那样会自己变。
      var termRevState = React.useState(0);
      var termRev = termRevState[0], setTermRev = termRevState[1];
      // 铁律② 天工快捷键最高优先（2026-09-22 用户钉死）：键位路由那一层把当前键位表交给壳，
      // 壳在**窗口有焦点时**注册成全局快捷键（其它应用与我们冲突时必须让我们），触发后把键位串
      // 送回来走同一条 fire()。shellChordRef 给页面自己那条原生路做去重（极少数机器两条路都会响）。
      var shellChordRef = React.useRef({ chord: '', t: 0 });
      var statusTextState = React.useState('就绪');
      var statusText = statusTextState[0], setStatusText = statusTextState[1];
      var showExplorerState = React.useState(true);    // ④ Ctrl+B 显隐文件树
      var showExplorer = showExplorerState[0], setShowExplorer = showExplorerState[1];
      // 左侧活动栏当前组（2026-09-20）：explorer | actions | settings
      var activityState = React.useState('explorer');
      var activity = activityState[0], setActivity = activityState[1];
      // 点活动栏图标：切组；**点当前那个 = 收起/展开面板**（VSCode 手感，与 Ctrl+B 同效）
      function pickActivity(id) {
        if (id === activity && showExplorer) { setShowExplorer(false); return; }
        setActivity(id);
        setShowExplorer(true);
      }
      var closedTabsState = React.useState([]);        // ④ Ctrl+Shift+T 重开栈（近 10 个）
      var closedTabs = closedTabsState[0], setClosedTabs = closedTabsState[1];
      var listStateState = React.useState(null);
      var listState = listStateState[0], setListState = listStateState[1];
      // 会话列表快照的 ref 镜像：定时器/延迟回调里的旧闭包也能读到最新值
      // （2026-09-02 stale closure：syncActiveRoot 曾读渲染期 listState，
      // 5s interval 与 800ms 收敛回调都持有旧闭包 → 新 root 永远不上报，
      // 表现为"第一次打开文件夹树不变、第二次才变"）
      var listStateRef = React.useRef(null);
      var convState = React.useState(null);
      var conv = convState[0], setConv = convState[1];
      var sessionFaceState = React.useState(null);
      var sessionFace = sessionFaceState[0], setSessionFace = sessionFaceState[1];
      var pluginsState = React.useState({ formal: [], dynamic: [] });
      var plugins = pluginsState[0], setPlugins = pluginsState[1];
      // ⑰ 面板尺寸（拖拽手柄）：改动一律走增量式 updater（避免拖拽回调里拿到旧的 layout 值）
      var layoutState = React.useState(readLayout);
      var layout = layoutState[0], setLayout = layoutState[1];
      function nudgeLayout(key, delta) {
        setLayout(function (prev) {
          var next = { sideW: prev.sideW, rightW: prev.rightW, termH: prev.termH };
          next[key] = prev[key] + delta;
          return clampLayout(next);
        });
      }
      function resetLayout(key) {
        setLayout(function (prev) {
          var next = { sideW: prev.sideW, rightW: prev.rightW, termH: prev.termH };
          next[key] = LAYOUT_DEF[key];
          return clampLayout(next);
        });
        trace('ui', 'info', 'layout-reset', { key: key });
      }
      React.useEffect(function () { writeLayout(layout); }, [layout]);
      // 窗口变小 → 重新夹取（否则两侧面板会把编辑区挤成 0）
      React.useEffect(function () {
        function onResize() { setLayout(function (prev) { return clampLayout(prev); }); }
        window.addEventListener('resize', onResize);
        return function () { window.removeEventListener('resize', onResize); };
      }, []);
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      var themeModeState = React.useState(function () {
        // 只保留 暗/亮 两态：system 偏好按当前生效色显示
        return props.theme ? props.theme.getTheme().active.colorScheme : 'dark';
      });
      var themeMode = themeModeState[0], setThemeMode = themeModeState[1];

      // ── 内置更新器（2026-09-16）：只在 AnzioAgent 壳里存在 window.anzioUpdater；
      // 浏览器打开 3081 时它 undefined → 标题栏不显示版本徽标 ──
      var updState = React.useState(null);
      var upd = updState[0], setUpd = updState[1];
      React.useEffect(function () {
        var bridge = window.anzioUpdater;
        if (!bridge) return;
        var alive = true;
        bridge.getState().then(function (s) { if (alive) setUpd(s); }).catch(function () { /* 忽略 */ });
        var off = bridge.onState(function (s) { if (alive) setUpd(s); });
        return function () { alive = false; if (typeof off === 'function') off(); };
      }, []);

      function checkUpdate() {
        var bridge = window.anzioUpdater;
        if (!bridge) return;
        setStatusText('正在检查更新…');
        bridge.check().then(function (r) {
          if (!r || !r.ok) { setStatusText('检查更新失败：' + ((r && r.error) || '读不到更新源')); return; }
          setStatusText(r.available
            ? ('发现新版本 v' + (r.latest && r.latest.version) + '（当前 v' + r.installed + '）')
            : ('已是最新版本 v' + r.installed));
        }).catch(function (e) { setStatusText('检查更新失败：' + String((e && e.message) || e)); });
      }

      function installUpdate() {
        var bridge = window.anzioUpdater;
        if (!bridge) return;
        setStatusText('正在下载更新…');
        bridge.install().then(function (r) {
          if (!r || !r.ok) { setStatusText('更新失败：' + ((r && r.error) || '')); return; }
          if (r.upToDate) { setStatusText('已是最新版本'); return; }
          setStatusText('v' + r.version + ' 已下载完成（' + r.files + ' 个文件）—— 点「重启并安装」生效');
        }).catch(function (e) { setStatusText('更新失败：' + String((e && e.message) || e)); });
      }

      function applyUpdate() {
        var bridge = window.anzioUpdater;
        if (!bridge) return;
        setStatusText('正在重启安装…');
        bridge.applyAndRestart();
      }

      // 订阅主题变化（外部切换/持久化恢复时同步按钮状态）
      React.useEffect(function () {
        if (!props.themeBus) return;
        function on(s) {
          setThemeMode(s.preference === 'system' ? s.active.colorScheme : s.preference);
        }
        props.themeBus.listeners.push(on);
        return function () {
          var i = props.themeBus.listeners.indexOf(on);
          if (i >= 0) props.themeBus.listeners.splice(i, 1);
        };
      }, []);

      function toggleTheme() {
        if (!props.theme) return;
        var next = themeMode === 'dark' ? 'light' : 'dark';
        props.theme.setTheme(next);
        setThemeMode(next);
        trace('ui', 'info', 'theme-switch', { mode: next });
      }

      // ── ⑮ 多标签：预览（VSCode preview editor）/ 打开 / 关闭族（脏确认）/ 固定（pin）──
      // 标签形状：{ name, path, dirty, preview, pinned }
      //   预览标签：同一时刻只有一个，再单击别的文件就**就地替换**它（不新增标签）；
      //     三条转正路径 = 双击树里的文件 / 双击标签 / 一开始编辑（变脏）/ Ctrl+K Enter。
      //   固定标签：永远排在未固定标签前面（VSCode 的 pinned tab），只显示图标；
      //     批量关闭（关闭其他 / 右侧 / 已保存 / 全部）一律**跳过固定标签**。
      function findTabIndex(list, path) {
        for (var i = 0; i < list.length; i++) if (list[i].path === path) return i;
        return -1;
      }
      // 固定的一律靠左（两组各自保持相对顺序）—— VSCode 的 pinned 区模型
      function pinFirst(list) {
        var pin = [], rest = [];
        for (var i = 0; i < list.length; i++) (list[i].pinned ? pin : rest).push(list[i]);
        return pin.concat(rest);
      }
      function tabItem(t, patch) {
        var out = {
          name: patch && patch.name !== undefined ? patch.name : t.name,
          path: patch && patch.path !== undefined ? patch.path : t.path,
          dirty: patch && patch.dirty !== undefined ? patch.dirty : t.dirty,
          preview: patch && patch.preview !== undefined ? patch.preview : !!t.preview,
          pinned: patch && patch.pinned !== undefined ? patch.pinned : !!t.pinned,
        };
        // 浏览器标签的附带信息（初始地址）必须一起带过去：tabItem 是"挑字段重建"的写法，
        // 漏掉它会让"改个固定状态/标题"顺手把地址丢了。
        var b = patch && patch.browser !== undefined ? patch.browser : t.browser;
        if (b) out.browser = b;
        // Markdown 预览状态同理：这是"挑字段重建"，漏一行就会被别的 patch（切固定/改名）顺手抹掉
        var mdp = patch && patch.mdPreview !== undefined ? patch.mdPreview : t.mdPreview;
        if (mdp) out.mdPreview = true;
        return out;
      }

      // mode = 'preview' → 临时预览（受偏好总开关约束）；其它/缺省 = 固定打开
      // ⚠ 这个函数原来紧跟上面那行注释；2026-09-22 加会话恢复时被误删过一次，别再把它的
      //   声明挤掉（函数体还在、声明没了 → 整个插件 bundle 报错、页面白屏）。
      function openTab(file, mode) {
        if (!file || !file.path) return;
        var wantPreview = (mode === 'preview') && tabPrefs.preview;
        setTabs(function (prev) {
          var at = findTabIndex(prev, file.path);
          if (at >= 0) {
            // 已开：只激活；这次若是"固定打开"，顺手把预览标签转正
            if (wantPreview || !prev[at].preview) return prev;
            var out0 = prev.slice();
            out0[at] = tabItem(prev[at], { preview: false });
            return out0;
          }
          var item = { name: file.name, path: file.path, dirty: false, preview: wantPreview, pinned: false };
          if (!wantPreview) return prev.concat([item]);
          // 预览：就地替换掉现有的那个预览标签（没有就追加到末尾）
          var pv = -1;
          for (var j = 0; j < prev.length; j++) if (prev[j].preview) { pv = j; break; }
          if (pv < 0) return prev.concat([item]);
          var out = prev.slice();
          out[pv] = item;
          return out;
        });
        setActivePath(file.path);
        trace('ui', 'info', 'open-tab', { path: file.path, preview: !!wantPreview });
      }

      // ── 内置浏览器：开一个浏览器标签（2026-09-30 立项）──────────────────────────
      // 路径用 browser:// 伪协议当标识，**它同时就是壳里那个原生视图的 id**（视图 id = 标签路径）
      // ⇒ 标签与视图一一对应，不用另维护一张映射表，也不会出现"标签关了视图还在"的错配。
      // ⚠ 刻意不进会话恢复（rememberSession 里跳过 browser://）：记忆里只存路径不存地址，
      //   恢复出来会是一个空白页 + 一个新视图，看着像坏了。
      function openBrowserTab(url) {
        if (!browserBridge()) {
          setStatusText('内置浏览器只在「天工」桌面版里可用（开发台是纯网页，没有原生视图）');
          return null;
        }
        var id = newBrowserId();
        setTabs(function (prev) {
          return prev.concat([{ name: '新标签页', path: id, dirty: false, preview: false, pinned: false, browser: { url: String(url || '') } }]);
        });
        setActivePath(id);
        // 中间列可能停在快捷键设置页/编辑器设置页 —— 开浏览器得先把编辑器正文让出来
        setCenterView('editor');
        trace('ui', 'info', 'browser-open', { id: id, url: String(url || '') });
        return id;
      }
      // Agent 在内置浏览器里开的标签（第二期）：视图**已经**在壳里建好了、id 由壳生成，
      // 界面这边只负责把标签开出来并激活 —— 标签路径必须**照抄**视图 id，两边全靠它一一对应，
      // 另生成一个 id 的话驱动层就认不出这块视图了。
      function openAgentTab(id, url) {
        if (!id) return;
        var path = String(id);
        setTabs(function (prev) {
          for (var i = 0; i < prev.length; i++) if (prev[i].path === path) return prev;   // 已经开着，只激活
          return prev.concat([{ name: 'Agent 正在打开…', path: path, dirty: false, preview: false, pinned: false, browser: { url: String(url || '') } }]);
        });
        setActivePath(path);
        setCenterView('editor');
        trace('ui', 'info', 'browser-agent-open', { id: path, url: String(url || '') });
      }
      function closeAgentTab(id) {
        if (!id) return;
        var path = String(id);
        var exists = false;
        for (var i = 0; i < tabs.length; i++) if (tabs[i].path === path) { exists = true; break; }
        if (!exists) return;
        // force：壳那边已经把视图销毁了，标签就算被钉住也得收掉，否则留一个点不开的死标签
        closeTab(path, true);
      }
      // 网页标题 → 标签名（浏览器标签的页签跟着网页走，VSCode 同款）
      function onBrowserTitle(path, title) {
        var nm = String(title || '').trim() || '新标签页';
        setTabs(function (prev) {
          var at = findTabIndex(prev, path);
          if (at < 0 || prev[at].name === nm) return prev;
          var out = prev.slice();
          out[at] = tabItem(prev[at], { name: nm });
          return out;
        });
      }

      // 会话恢复 / Hot Exit（见 rememberSession 注释）：root 一确定就把上次开着的标签装回来。
      // 落盘时机（对齐 VSCode 的 hot exit = 退出时快照，并额外补两层防"被杀进程/崩"）：
      //   ① 编辑器状态变化（tabs / activePath / root）—— 老路子
      //   ② 缓冲区内容变化后**去抖 1.2s** —— 保证"连续打字、中途不切标签"也不丢字（v1 的洞）
      //   ③ 窗口失焦 / 页面隐藏 / beforeunload / pagehide —— "离开那一刻"的最后一笔
      //      （localStorage 是同步写，卸载回调里也能落）
      var restoredRootRef = React.useRef(null);
      var draftGetterRef = React.useRef(null);   // Editor 挂载后提供"读脏缓冲区正文 + 基准版本"的能力
      var persistRef = React.useRef(null);       // 监听器/去抖回调要用"最新闭包"的 persistSession
      var persistTimerRef = React.useRef(null);
      // 用户把「重开软件时恢复上次打开的文件」重新打开时，用它触发一次"立刻恢复"
      var sessionTickState = React.useState(0);
      var sessionTick = sessionTickState[0], setSessionTick = sessionTickState[1];
      function persistSession() {
        if (!tabPrefs.restoreSession) return;
        // ⚠ 恢复没落定前绝不写：此刻 tabs 还是空的，写了就把刚读出来的记忆擦掉（原来这条判据只在
        //    effect 里，现在所有调用方共用它 —— 去抖/退出回调会从别的路径进来）
        if (!root || restoredRootRef.current !== root) return;
        var drafts = {};
        var get = draftGetterRef.current;
        if (get) {
          for (var i = 0; i < tabs.length; i++) {
            if (!tabs[i].dirty) continue;
            var info = null;
            try { info = get(tabs[i].path); } catch (e) { info = null; }
            if (info && typeof info.text === 'string') drafts[tabs[i].path] = info;
          }
        }
        rememberSession(root, tabs, activePath, drafts);
        // 落盘埋点：出"标签丢了"这类问题时，靠它一眼看出是哪一次写、写进去几个
        // 30s 合并：正常编辑时它每几秒就写一次，逐条记没有额外信息
        traceEvery('session-persist', 30000, 'ui', 'info', 'session-persist', {
          tabs: tabs.length, drafts: Object.keys(drafts).length,
          names: tabs.slice(0, 8).map(function (t) { return String(t && t.name || '') }).join(','),
        });
      }
      persistRef.current = persistSession;      // 每次渲染刷新
      function schedulePersist(delay) {
        if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
        persistTimerRef.current = setTimeout(function () {
          persistTimerRef.current = null;
          try { if (persistRef.current) persistRef.current() } catch (e) { /* 忽略 */ }
        }, delay || 1200);
      }
      React.useEffect(function () {
        function flush() { try { if (persistRef.current) persistRef.current() } catch (e) { /* 忽略 */ } }
        function onVis() { if (document.visibilityState === 'hidden') flush() }
        window.addEventListener('blur', flush);
        window.addEventListener('beforeunload', flush);
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', onVis);
        return function () {
          window.removeEventListener('blur', flush);
          window.removeEventListener('beforeunload', flush);
          window.removeEventListener('pagehide', flush);
          document.removeEventListener('visibilitychange', onVis);
          if (persistTimerRef.current) { clearTimeout(persistTimerRef.current); persistTimerRef.current = null }
        };
      }, []);
      React.useEffect(function () {
        if (!root || restoredRootRef.current === root) return;
        if (!tabPrefs.restoreSession) { restoredRootRef.current = root; return }
        var cancelled = false;
        // ① 先问 host 要磁盘上那份会话快照（VSCode 式：备份在磁盘）；② 拿不到再退回页面本机记忆。
        apiGet('/session').then(function (r) {
          if (cancelled) return null;
          if (r && r.data) { SESSION_STORE = normalizeStore(r.data); return SESSION_STORE }
          SESSION_STORE = readSessionStore();
          return SESSION_STORE;
        }).catch(function () {
          SESSION_STORE = readSessionStore();
          return SESSION_STORE;
        }).then(function (store) {
          if (cancelled || !store) return;
          var rec = store.roots[root];
          if (!rec || !rec.tabs || !rec.tabs.length) { restoredRootRef.current = root; return }
          var list = [];
          var paths = [];
          for (var i = 0; i < rec.tabs.length && list.length < MAX_TABS; i++) {
            var t = rec.tabs[i];
            if (!t || !t.p || !t.n) continue;
            list.push({ name: String(t.n), path: String(t.p), dirty: !!t.dirty, preview: false, pinned: !!t.pinned });
            paths.push(String(t.p));
          }
          if (!list.length) { restoredRootRef.current = root; return }
          // ⚠ restoredRootRef 留到这次异步**落定之后**再置位：中途 tabs 还是空的，
          //    若此刻放开写入，就会用空列表把刚读出来的记忆擦掉（第一次实现踩到过）。
          // 逐个问 host "这个文件还在吗"。三种结果要分开对待（2026-09-22 血案，见 ORPHAN_RECORDS 注释）：
          //   alive   —— exists:true 且不是目录 → 正常恢复成标签
          //   gone    —— 后端**明确**回 exists:false → 真被删了，丢弃（判据必须是 exists === false 且无 error；
          //              /stat 不存在时回的是 {exists:false} 没有 error 字段）
          //   unknown —— 请求失败 / 回答不成形 → **不算没了**，留在记忆里下次再问（绝不因此丢草稿）
          Promise.all(paths.map(function (p) {
            return apiGet('/stat', { path: p }).then(function (r) {
              var alive = !!(r && r.exists === true && !r.error && r.type !== 'directory');
              var gone = !alive && !!(r && r.exists === false && !r.error);
              return { p: p, ok: alive, gone: gone };
            }).catch(function () { return { p: p, ok: false, gone: false }; });
          })).then(function (rows) {
            if (cancelled) return;
            var alive = {};
            var unknown = {};
            for (var j = 0; j < rows.length; j++) {
              if (rows[j].ok) alive[rows[j].p] = true;
              else if (!rows[j].gone) unknown[rows[j].p] = true;
            }
            var kept = list.filter(function (t) { return alive[t.path]; });
            // 问不出结果的（含它没被恢复这件事本身）留给下次开机重试
            setOrphanRecords(root, list, rec.drafts, unknown);
            if (kept.length) {
              // 脏标签的草稿（正文 + 基准磁盘版本）交给 Editor，等它读盘建好 model 再套上
              for (var d in rec.drafts) {
                var dr = rec.drafts[d];
                if (alive[d] && dr && typeof dr.t === 'string') putPendingDraft(d, { text: dr.t, base: dr.b || null });
              }
              setTabs(kept);
              var active = rec.active && alive[rec.active] ? rec.active : kept[kept.length - 1].path;
              setActivePath(active);
            }
            restoredRootRef.current = root;
            trace('ui', 'info', 'session-restored', {
              root: root, tabs: kept.length, drafts: Object.keys(rec.drafts || {}).length,
              unknown: Object.keys(unknown).length,
            });
          });
        });
        return function () { cancelled = true };
      }, [root, sessionTick]);
      React.useEffect(function () {
        if (!root || restoredRootRef.current !== root) return;   // 恢复还没落定前别写（否则用空列表把记忆擦了）
        persistSession();
      }, [tabs, activePath, root]);

      function onDirtyChange(path, dirty) {
        // hot exit：正文一变就排一次快照（去抖）—— 内容变化本身不会改 tabs，光靠 ① 那层会漏字
        schedulePersist(1200);
        setTabs(function (prev) {
          var hit = -1, wasDirty = null;
          for (var q = 0; q < prev.length; q++) if (prev[q].path === path) { hit = q; wasDirty = prev[q].dirty; break; }
          try {
            window.__dirtyDbg = (window.__dirtyDbg || []).concat([{
              t: Math.round(performance.now()), path: String(path).split('\\').pop(),
              want: !!dirty, tabs: prev.length, hit: hit, was: wasDirty,
            }]).slice(-20);
          } catch (e) { /* 忽略 */ }
          var changed = false;
          var next = prev.map(function (t) {
            if (t.path !== path) return t;
            // 预览标签一动就转正（VSCode 同款：开始编辑 = 你打算留着它）
            if (t.dirty !== dirty || (dirty && t.preview)) {
              changed = true;
              return tabItem(t, { dirty: dirty, preview: dirty ? false : t.preview });
            }
            return t;
          });
          return changed ? next : prev;
        });
      }

      // 转正（VSCode 的 Keep Editor：Ctrl+K Enter / 双击树里的文件 / 双击标签）
      function promoteTab(path) {
        var target = path || activePath;
        if (!target) return;
        setTabs(function (prev) {
          var at = findTabIndex(prev, target);
          if (at < 0 || !prev[at].preview) return prev;
          var out = prev.slice();
          out[at] = tabItem(prev[at], { preview: false });
          return out;
        });
        trace('ui', 'info', 'tab-promote', { path: target });
      }

      // 关闭一批标签（单个关闭也走它）：脏的先问一次（批量合成一次确认）
      // force=false（键盘 Ctrl+W / 中键 / 标签上的按钮）时**保护固定标签**——VSCode 的
      // preventPinnedEditorClose='keyboardAndMouse'：不关它，改成跳到下一个没固定住的标签。
      // 右键菜单里的「关闭」传 force=true（VSCode 源码注释：menu: always close, even sticky ones）。
      // noConfirm 只给"内容已经落到别处"的调用方（另存为）：正文都写进新文件了，再问"未保存"就是错的
      // —— 而且在自动化里有硬后果：window.confirm 会**阻塞渲染进程**（CDP 下等对话框应答，2026-09-29 实测）。
      function closeTabPaths(paths, label, force, noConfirm) {
        if (!paths || !paths.length) return;
        var list = [], skippedPinned = false, q;
        for (q = 0; q < paths.length; q++) {
          var at0 = findTabIndex(tabs, paths[q]);
          if (at0 < 0) continue;
          if (tabs[at0].pinned && !force) { skippedPinned = true; continue; }
          list.push(paths[q]);
        }
        if (!list.length) {
          if (skippedPinned) focusNextUnpinned(activePath);
          return;
        }
        var set = {}, i;
        for (i = 0; i < list.length; i++) set[list[i]] = true;
        var doomed = [];
        for (i = 0; i < tabs.length; i++) if (set[tabs[i].path]) doomed.push(tabs[i]);
        if (!doomed.length) return;
        var dirty = doomed.filter(function (t) { return t.dirty; });
        if (dirty.length && !noConfirm) {
          var msg = dirty.length === 1
            ? ('「' + dirty[0].name + '」有未保存的更改，关闭将丢失这些更改。确定关闭？')
            : ('有 ' + dirty.length + ' 个标签还有未保存的更改，关闭将丢失这些更改。确定关闭？');
          if (!window.confirm(msg)) return;
        }
        var bridge = editorBridgeRef.current;
        var bb = browserBridge();
        for (i = 0; i < doomed.length; i++) {
          // 浏览器标签：原生视图是壳里的资源，标签关掉就必须把视图一起销毁（否则留下看不见的活页面）
          if (bb && isBrowserPath(doomed[i].path)) { try { bb.destroy(doomed[i].path); } catch (e) { /* 忽略 */ } continue }
          if (bridge && bridge.disposeModel) { try { bridge.disposeModel(doomed[i].path); } catch (e) { /* 忽略 */ } }
        }
        // 接替者：关掉那批之后右边最近的存活标签，没有就左边最近
        var firstIdx = -1;
        for (i = 0; i < tabs.length; i++) if (set[tabs[i].path]) { firstIdx = i; break; }
        var activeClosed = !!(activePath && set[activePath]);
        var nextPath = null;
        if (activeClosed) {
          for (i = firstIdx + 1; i < tabs.length; i++) if (!set[tabs[i].path]) { nextPath = tabs[i].path; break; }
          if (!nextPath) for (i = firstIdx - 1; i >= 0; i--) if (!set[tabs[i].path]) { nextPath = tabs[i].path; break; }
        }
        setTabs(function (prev) { return prev.filter(function (t) { return !set[t.path]; }); });
        if (activeClosed) setActivePath(nextPath);
        // ④ 记入重开栈（Ctrl+Shift+T），近 10 个
        // 浏览器标签不进重开栈：栈里只存 name/path，重开出来是一个没有地址的空页面（看着像坏了）
        setClosedTabs(function (prev) {
          var add = doomed.filter(function (t) { return !isPseudoPath(t.path) })
            .map(function (t) { return { name: t.name, path: t.path }; });
          return add.concat(prev).slice(0, 10);
        });
        trace('ui', 'info', 'close-tabs', { kind: label || 'close', count: doomed.length });
      }

      function closeTab(path, force, noConfirm) {
        closeTabPaths([path || activePath], 'close', !!force, !!noConfirm);
      }
      // 会话恢复兜底：恢复出来的标签其实已经读不出来了 → 关掉它并说清楚（别留空白标签）
      function onMissingFile(path, why) {
        var nm = path ? String(path).split(/[\\/]/).pop() : '';
        setStatusText('「' + nm + '」已经不在了（' + why + '），已从打开的文件里移除');
        trace('ui', 'warn', 'restored-file-missing', { path: path, why: why });
        var bridge = editorBridgeRef.current;
        if (bridge && bridge.disposeModel) { try { bridge.disposeModel(path); } catch (e) { /* 忽略 */ } }
        setTabs(function (prev) { return prev.filter(function (t) { return t.path !== path; }); });
        setActivePath(function (cur) { return cur === path ? null : cur; });
      }
      // 固定标签被"键鼠关闭"拦下时：跳到下一个没固定住的标签（VSCode 同款）
      function focusNextUnpinned(path) {
        var at = findTabIndex(tabs, path);
        if (at < 0) return;
        for (var i = at + 1; i < tabs.length; i++) if (!tabs[i].pinned) { setActivePath(tabs[i].path); return; }
        for (var j = 0; j < tabs.length; j++) if (!tabs[j].pinned) { setActivePath(tabs[j].path); return; }
      }
      function closeOthers(path) {
        var keep = path || activePath;
        promoteTab(keep);   // VSCode：保留下来的那个会被转正（不再是预览）
        closeTabPaths(tabs.filter(function (t) { return t.path !== keep && !t.pinned; }).map(function (t) { return t.path; }), 'close-others');
      }
      function closeRight(path) {
        var target = path || activePath;
        var at = findTabIndex(tabs, target);
        if (at < 0) return;
        promoteTab(target);   // VSCode：关闭右侧前先把被点的那一个转正
        var list = [];
        for (var i = at + 1; i < tabs.length; i++) if (!tabs[i].pinned) list.push(tabs[i].path);
        closeTabPaths(list, 'close-right');
      }
      function closeSaved() {
        closeTabPaths(tabs.filter(function (t) { return !t.dirty && !t.pinned; }).map(function (t) { return t.path; }), 'close-saved');
      }
      function closeAll() {
        closeTabPaths(tabs.filter(function (t) { return !t.pinned; }).map(function (t) { return t.path; }), 'close-all');
      }

      // 固定 / 取消固定（固定 = 靠左 + 只显示图标 + 批量关闭跳过）
      function setTabPinned(path, pinned) {
        setTabs(function (prev) {
          var at = findTabIndex(prev, path);
          if (at < 0) return prev;
          var out = prev.map(function (t, i) { return i === at ? tabItem(t, { pinned: pinned, preview: pinned ? false : t.preview }) : t; });
          return pinFirst(out);
        });
        trace('ui', 'info', pinned ? 'tab-pin' : 'tab-unpin', { path: path });
      }
      function togglePinTab(path) {
        var target = path || activePath;
        if (!target) return;
        var at = findTabIndex(tabs, target);
        if (at < 0) return;
        setTabPinned(target, !tabs[at].pinned);
      }

      // 复制路径 / 相对路径 · 在文件资源管理器中显示（壳里才有那个桥，浏览器里自动降级）
      function fallbackCopy(text) {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', 'readonly');
          ta.style.position = 'fixed';
          ta.style.left = '-10000px';
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          return !!ok;
        } catch (e) { return false; }
      }
      function copyToClipboard(text) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
            return true;
          }
        } catch (e) { /* 落到兜底 */ }
        return fallbackCopy(text);
      }
      function relPathOf(target) {
        var r = String(root || '');
        if (r && target.length > r.length && target.slice(0, r.length).toLowerCase() === r.toLowerCase()) {
          return target.slice(r.length).replace(/^[\\/]+/, '');
        }
        return target;
      }
      function copyTabPath(path, rel) {
        var target = path || activePath;
        if (!target) { setStatusText('没有可复制的文件'); return; }
        var text = rel ? relPathOf(target) : target;
        copyToClipboard(text);
        setStatusText('已复制路径：' + text);
        trace('ui', 'info', 'copy-path', { rel: !!rel, text: text });
      }
      // ③「在终端中打开」（VSCode 规格核实于本地 vscode-src：目录取它自己、文件取它的父目录
      //   dirname；命令 openInIntegratedTerminal，Explorer 右键 navigation 组 order 30）。
      //   用户 2026-09-22 拍板 B 方案：面板目前是单终端 —— 直接换 cwd 重建（旧 PTY 随组件卸载关掉）。
      function dirnameOf(p) {
        var s = String(p || '');
        var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
        return i > 0 ? s.slice(0, i) : s;
      }
      function openTerminalAt(dir) {
        if (!dir) return;
        setTermCwd(function (cur) { return cur === dir ? cur : dir });   // 同目录就只显示，不白重建一次
        setTermOpen(true);
        setStatusText('已在终端中打开：' + relDisplay(dir, root));
        trace('ui', 'info', 'terminal-open-at', { dir: dir });
      }

      // ① 从资源管理器/桌面把文件拖进**编辑区** = 打开它（VSCode 行为；工作区外的文件照样开）。
      //    ⚠ 必须自己 preventDefault + stopPropagation：平台的附件组件在 document 上监听 drop，
      //      不拦就会变成对话框的参考文件（2026-09-22 用户报障："以前拖到中间面板就打开了"）。
      //    拿不到本机路径（浏览器里没有壳桥）就**不拦**，照旧交给平台，免得把功能吃掉。
      //    （Electron 43 里 File.path 已被移除，路径只能靠壳暴露的 webUtils 桥来拿。）
      function droppedPaths(dt, needPaths) {
        if (!dt || !dt.types || Array.prototype.indexOf.call(dt.types, 'Files') < 0) return null;
        var sh = (typeof window !== 'undefined') ? window.anzioShell : null;
        if (!sh || typeof sh.getFilePath !== 'function') return null;
        var files = dt.files || [];
        if (!files.length) return needPaths ? null : [];     // dragover 阶段常常还拿不到 files
        if (!needPaths) return [];
        var out = [];
        for (var i = 0; i < files.length; i++) {
          var p = '';
          try { p = sh.getFilePath(files[i]) || '' } catch (err) { p = '' }
          if (p) out.push(p);
        }
        return out;
      }
      function onEditorDragOver(e) {
        var dt = e.dataTransfer;
        if (droppedPaths(dt, false) === null) return;        // 不是文件 / 没有壳 → 不插手
        e.preventDefault(); e.stopPropagation();
        try { dt.dropEffect = 'copy' } catch (err) { /* 只读环境忽略 */ }
      }
      // 平台的"文件或图片拖动到此处即可添加"蒙层，判据是它挂在 **document** 上的 dragenter 计数。
      // 编辑区自己接 drop，就不要它这一区冒蒙层 —— 只挡冒泡、不 preventDefault（拖放照旧有效）。
      function onEditorDragEnter(e) {
        if (droppedPaths(e.dataTransfer, false) === null) return;
        e.stopPropagation();
      }
      function onEditorDrop(e) {
        var paths = droppedPaths(e.dataTransfer, true);
        if (!paths || !paths.length) return;
        e.preventDefault(); e.stopPropagation();
        for (var i = 0; i < paths.length; i++) {
          var p = paths[i];
          openTab({ name: p.split('\\').pop().split('/').pop(), path: p });
        }
        setStatusText('已打开拖入的 ' + paths.length + ' 个文件');
        trace('ui', 'info', 'editor-drop-open', { count: paths.length, first: paths[0] });
        // ⚠ 我们把平台的 drop 拦下来了（不然文件会变成对话框附件）→ 它就永远等不到自己那次 reset，
        //   蒙层会一直挂在最顶层（2026-09-22 用户报障）。它在 window 上挂了 dragend → reset，
        //   补一个合成 dragend 替它复位（外层已有兜底：dragover/drop 冒泡也被我们挡了）。
        try { window.dispatchEvent(new Event('dragend')) } catch (err) { /* 老环境忽略 */ }
      }

      // VSCode 的判据（contrib/files/browser/files.ts:117-152 getMultiSelectedResources / :102-114 getResourceForCommand）：
      // **资源管理器列表是焦点所在 → 用它选中的资源**，否则才退回活动编辑器。
      // 天工的树节点没有 DOM 焦点能力（全文件搜不到 tabIndex），能对上的等价分界线 = "焦点在不在编辑器里"：
      //   在编辑器里 → 当前文件；否则（点过树/活动栏、刚开应用）→ 树里最近聚焦的节点 treeSel。
      // 少这个判据的后果：在树里选中文件夹按 Shift+Alt+R，会去定位当前打开的标签（2026-09-29 用户报障）。
      function revealTarget() {
        var a = (typeof document !== 'undefined') ? document.activeElement : null;
        var inEditor = !!(a && a.closest && a.closest('.dside-editor'));
        if (!inEditor && treeSel && treeSel.path) return treeSel.path;
        return activePath;
      }
      function revealInExplorer(path) {
        var target = path || activePath;
        if (!target) return;
        var sh = (typeof window !== 'undefined') ? window.anzioShell : null;
        if (!sh || !sh.revealInFolder) { setStatusText('当前环境不支持“在文件资源管理器中显示”（应用内可用）'); return; }
        sh.revealInFolder(target).then(function (r) {
          setStatusText(r && r.ok ? '已在资源管理器中定位' : ('定位失败' + (r && r.code ? ('：' + r.code) : '')));
          trace('ui', r && r.ok ? 'info' : 'warn', 'reveal-in-explorer', { path: target, ok: !!(r && r.ok) });
        });
      }

      // ── ④ 键位配套动作：重开已关 / 相邻标签切换 / 文件树显隐 ──
      function reopenClosedTab() {
        if (!closedTabs.length) { setStatusText('没有可重新打开的标签'); return; }
        var it = closedTabs[0];
        var dup = false;
        for (var i = 0; i < tabs.length; i++) if (tabs[i].path === it.path) { dup = true; break; }
        if (!dup) {
          setTabs(function (prev) { return prev.concat([{ name: it.name, path: it.path, dirty: false }]); });
        }
        setActivePath(it.path);
        setClosedTabs(closedTabs.slice(1));
        trace('ui', 'info', 'reopen-tab', { path: it.path });
      }
      function activateTab(dir) {
        if (!tabs.length) return;
        var idx = -1;
        for (var i = 0; i < tabs.length; i++) if (tabs[i].path === activePath) { idx = i; break; }
        var next = idx < 0 ? 0 : (idx + dir + tabs.length) % tabs.length;
        if (next !== idx) activatePath(tabs[next].path, 'keyboard');
      }
      // 标签激活（2026-10-19 补）：以前只有开/关/拖，切到哪个标签完全没痕，
      // "点了没反应/打开了但没显示"这类报障无法还原现场。
      function activatePath(path, via) {
        if (!path || path === activePath) return;
        trace('ui', 'info', 'tab-activate', { path: String(path), via: via || 'click' });
        setActivePath(path);
      }
      function toggleExplorer() {
        setShowExplorer(function (v) { return !v; });
        trace('ui', 'info', 'toggle-explorer');
      }
      // ⑫ A4 标签拖拽排序：把 from 插到 to 前面（保持其它标签相对顺序）
      function moveTab(from, to) {
        if (!from || !to || from === to) return;
        setTabs(function (prev) {
          var src = null;
          var rest = [];
          for (var i = 0; i < prev.length; i++) {
            if (prev[i].path === from) src = prev[i];
            else rest.push(prev[i]);
          }
          if (!src) return prev;
          var out = [];
          var placed = false;
          for (var j = 0; j < rest.length; j++) {
            if (!placed && rest[j].path === to) { out.push(src); placed = true; }
            out.push(rest[j]);
          }
          if (!placed) out.push(src);
          // 固定标签永远靠左：拖拽不能把未固定的挪到固定区之前（VSCode 的 pinned 区）
          return pinFirst(out);
        });
        trace('ui', 'info', 'tab-move', { from: from, to: to });
      }

      function openCommands() {
        prevFocusRef.current = document.activeElement;
        setSearchOpen(false);
        setOverlay(function (p) { return p === 'commands' ? null : 'commands'; });
      }

      // ── ③ 跳转：打开/激活 tab + 携带定位意图（Editor 消费 gotoReq）──
      // ⑮ 代码导航（F12 / 搜索结果 / 问题面板）的预览语义 —— 与 VSCode 源码一致
      // （services/editor/browser/codeEditorService.ts#L76-L100）：
      //   · 目标一律以"预览"打开（预览模式总开关关掉时才不用）；
      //   · fromCodeNav = false（VSCode 默认）时，**先把来源标签转正**，
      //     否则跳转目标会把这个预览标签顶掉（用户正在看的文件就没了）。
      function navTargetMode() { return tabPrefs.preview ? 'preview' : null; }
      function protectNavSource() {
        if (!tabPrefs.preview || tabPrefs.fromCodeNav || !activePath) return;
        promoteTab(activePath);
      }
      function jumpToFile(file, line, col) {
        protectNavSource();
        openTab(file, navTargetMode()); // 已开则去重只激活；未开则开新 tab
        gotoSeqRef.current += 1;
        setGotoReq({ seq: gotoSeqRef.current, path: file.path, line: line | 0, col: col | 0 });
      }

      // ⑤ 转到定义：目标文件可能根本不在标签里（worker 只给绝对路径 + 字符偏移）→
      // 合成 file 对象走同一条 openTab/gotoReq 链路；文件没打开时先带 offset，模型挂好后由
      // Editor 的 doReveal 换算成行列
      function jumpToPath(path, line, col, offset) {
        if (!path) return;
        protectNavSource();
        openTab({ name: String(path).split('\\').pop(), path: path }, navTargetMode());
        gotoSeqRef.current += 1;
        setGotoReq({
          seq: gotoSeqRef.current,
          path: path,
          line: line | 0,
          col: col | 0,
          offset: (offset === undefined || offset === null) ? null : (offset | 0),
        });
      }

      function restoreFocus() {
        var pf = prevFocusRef.current;
        prevFocusRef.current = null;
        if (pf && pf.focus) { try { pf.focus(); } catch (e) { /* ignore */ } }
      }

      function closeOverlays() {
        setOverlay(null);
        setSearchOpen(false);
        restoreFocus();
      }

      // ④ 键位动作与 UI 状态镜像 ref：keydown effect 回调一律经 ref 取最新值/动作，
      // 避免 stale closure（2026-09-02 踩坑 22）
      var keyUiRef = React.useRef({ overlay: null, searchOpen: false, activePath: null, tabCount: 0 });
      keyUiRef.current = { overlay: overlay, searchOpen: searchOpen, activePath: activePath, tabCount: tabs.length };
      var keyActRef = React.useRef({});
      keyActRef.current = {
        closeTab: closeTab, reopenClosedTab: reopenClosedTab, activateTab: activateTab,
        openBrowserTab: openBrowserTab,   // 壳那边拦下的新窗口（target=_blank）走这里开新标签
        openAgentTab: openAgentTab,       // Agent 开的内置浏览器标签
        closeAgentTab: closeAgentTab,
        toggleExplorer: toggleExplorer, openCommands: openCommands, closeOverlays: closeOverlays,
        closeAll: closeAll, closeSaved: closeSaved, promoteTab: promoteTab, togglePinTab: togglePinTab,
        copyPath: function () { copyTabPath(activePath, false); },
        saveAll: function () { var b = editorBridgeRef.current; if (b && b.saveAll) b.saveAll(); },
      };

      // ④ 键位实现表（**只有需要读组件状态的那些**才在这里登记；其余走命令表，见 fire()）：
      // 每次渲染重写一遍 = 回调永远拿到最新状态（同 keyActRef 的套路）
      var keyImpl = {
        'view.commands': function () { var a = keyActRef.current; a.openCommands(); },
        'view.quickOpen': function () {
          prevFocusRef.current = document.activeElement;
          setSearchOpen(false);
          setOverlay(function (prev) { return prev === 'files' ? null : 'files'; });
        },
        'view.search': function () {
          prevFocusRef.current = document.activeElement;
          setOverlay(null);
          setSearchOpen(function (prev) { return !prev; });
        },
        'view.problems': function () {
          prevFocusRef.current = document.activeElement;
          setSearchOpen(false);
          setOverlay(function (prev) { return prev === 'problems' ? null : 'problems'; });
        },
        'view.explorer': function () { keyActRef.current.toggleExplorer(); },
        'view.terminal': function () {
          // ⚠ 必须在 updater 里读当前值：这里用闭包里的 termOpen 会把方向算反
          //（v1.5.31 及以前 `open: !termOpen` 记的**永远是 true**，日志说谎 —— 2026-09-21 修正）
          setTermOpen(function (v) { var next = !v; trace('ui', 'info', 'terminal-toggle', { open: next }); return next });
        },
        'view.nextTab': function () { keyActRef.current.activateTab(1); },
        'view.prevTab': function () { keyActRef.current.activateTab(-1); },
        // Ctrl+L：焦点送进内置浏览器的地址栏（浏览器惯例键）。同一时刻只有一个浏览器面板可见，
        // 所以按类名取那一个输入框就够；没有浏览器标签时明说一句，别静默没反应。
        'browser.focusUrl': function () {
          var el = document.querySelector('.dside-browser-url');
          if (el && el.focus) { try { el.focus(); el.select(); } catch (err) { /* 忽略 */ } }
          else setStatusText('当前没有打开的内置浏览器标签');
        },
        'view.keybindings': function () { openKeybindings(); },
        'view.editorSettings': function () { openEditorSettings(); },
        // Ctrl+W：有面板先关面板，否则关当前标签（VSCode 同款）
        'file.close': function () {
          var ui = keyUiRef.current, a = keyActRef.current;
          if (ui.overlay || ui.searchOpen) a.closeOverlays();
          else if (ui.activePath) a.closeTab(ui.activePath);
        },
        'file.copyPath': function () { keyActRef.current.copyPath(); },
        'update.check': function () { checkUpdate(); },
        // 差异标签的上一处 / 下一处（Alt+Shift+F5 / Alt+F5）：没有差异标签时明说一句，别静默没反应
        'review.nextChange': function () {
          if (REVIEW_STEP.fn) REVIEW_STEP.fn(1); else setStatusText('当前没有打开的差异标签');
        },
        'review.prevChange': function () {
          if (REVIEW_STEP.fn) REVIEW_STEP.fn(-1); else setStatusText('当前没有打开的差异标签');
        },
        'file.keepOpen': function () { if (activePath) promoteTab(activePath); },
        'file.togglePin': function () { if (activePath) togglePinTab(activePath); },
        'md.togglePreview': function () { toggleMdPreview(); },
      };
      KEY_IMPL = keyImpl;
      CMD_RUN = runCommandById;   // 命令分发指针（每渲染刷新，防 stale closure —— 见 fire()）
      // 自检钩子（同 window.__dsideKeys / __dsideKB 那套）：探针要验预览状态与切换，不必猜类名。
      // **每渲染重写** —— 缓存住就会读到上一轮的状态。
      try {
        window.__dsideMD = {
          state: function () {
            var t = null;
            for (var i = 0; i < tabs.length; i++) if (tabs[i].path === activePath) t = tabs[i];
            return { active: activePath, name: t ? t.name : '', mdPreview: !!(t && t.mdPreview) };
          },
          toggle: function () { toggleMdPreview(); return true; },
          openPreview: function (p, n) { openMarkdownPreview(p, n); return true; },
          version: 1,
        };
      } catch (e) { /* 非浏览器环境 */ }

      // ④ 键盘路由（window capture：先于 monaco / 输入控件收到按键）
      // **不写死任何键位** —— 全部来自 KEYMAP（键位注册表），所以「快捷键设置」里改完立刻生效。
      // 支持任意长度的和弦（Ctrl+K S 这种二段键由 prefixes 自动识别）。
      var chordTimerRef = React.useRef(null);
      React.useEffect(function () {
        var router = buildKeyRouter();
        // 铁律②：把当前键位表交给壳 —— 窗口有焦点时它们就是这个系统上最高优先的快捷键
        // （其它应用抢了/输入法吞了都由这条路救回来）。录键期间交空表，让按键回到页面好录。
        var shellApi = (typeof window !== 'undefined') ? window.anzioShell : null;
        var shellChords = shellHotkeyChords();
        if (shellApi && typeof shellApi.setHotkeys === 'function') {
          try { shellApi.setHotkeys(KEYS_RECORDING ? [] : shellChords); } catch (err) { /* 忽略 */ }
        }
        var offShellHotkey = (shellApi && typeof shellApi.onHotkey === 'function')
          ? shellApi.onHotkey(function (chord) {
              if (KEYS_RECORDING) return;                     // 录键时让路
              var nn = normalizeChord(chord);
              var hid = router.map[nn];
              if (!hid) return;
              shellChordRef.current = { chord: nn, t: Date.now() };
              trace('key', 'info', 'shortcut-via-shell', { id: hid, keys: chord });
              fire(hid, chord, null);                          // 与页面原生路共用同一套实现
            })
          : null;
        // 内置浏览器页面上报的 Ctrl/Alt 组合键（页面自己消费掉的不报）→ 走同一套键位路由。
        // ⚠ 必须去重：窗口有焦点时天工键位全都注册成了壳的全局热键（§0.4 铁律②），在浏览器视图里
        //   按一个键会**同时**走"全局热键"和"页面 preload 上报"两条路 → 不去重就一次执行两遍。
        //   判据 = shellChordRef（全局热键那条路刚记下的键位 + 时刻）。
        var offBrowserKey = (shellApi && typeof shellApi.onBrowserKey === 'function')
          ? shellApi.onBrowserKey(function (payload) {
              if (KEYS_RECORDING || !payload) return;
              var nn = normalizeChord(chordOfEvent({
                ctrlKey: !!payload.ctrl, altKey: !!payload.alt, shiftKey: !!payload.shift, metaKey: !!payload.meta,
                key: payload.key, code: payload.code,
              }));
              if (!nn) return;
              var recent = shellChordRef.current;
              if (recent && recent.chord === nn && (Date.now() - recent.t) < 400) return;
              var hid = router.map[nn];
              if (!hid) return;
              trace('key', 'info', 'shortcut-via-browser-view', { id: hid, keys: nn });
              fire(hid, nn, null);
            })
          : null;
        // 内置浏览器：页面每次加载都会把"标签"丢光，而壳里的原生视图还活着 → 开局清一次场，
        // 免得留下无主的活页面。标记挂在 window 上 = **一次页面加载只清一次**（不是每次改键位都清）。
        if (shellApi && shellApi.browser && shellApi.browser.available && !window.__dsideBrowserResetDone) {
          window.__dsideBrowserResetDone = true;
          try { shellApi.browser.reset(); } catch (err) { /* 忽略 */ }
        }
        // 网页里的 target=_blank：壳拦下（不开原生窗口）交回这里，在天工里开一个新浏览器标签
        var offBrowserEvt = (shellApi && shellApi.browser && shellApi.browser.available && typeof shellApi.browser.onEvent === 'function')
          ? shellApi.browser.onEvent(function (ev) {
              if (!ev) return;
              if (ev.type === 'open-tab' && ev.url) { keyActRef.current.openBrowserTab(ev.url); return }
              // Agent 自己开的/关的标签（壳桥建/销视图后通知界面）——界面要看得见 Agent 在开什么
              if (ev.type === 'agent-open') { keyActRef.current.openAgentTab(ev.id, ev.url); return }
              if (ev.type === 'agent-close') { keyActRef.current.closeAgentTab(ev.id); return }
            })
          : null;
        // Agent 的按键记账（第三期）→ 中下方面板里的「键盘映射」。壳那边已经按幻影开关过滤过，
        // 关掉幻影时这条流根本不会来（面板不亮），这也是设计稿要的"一个开关管全部"。
        var offBrowserAction = (shellApi && shellApi.browser && shellApi.browser.available && typeof shellApi.browser.onBrowserAction === 'function')
          ? shellApi.browser.onBrowserAction(function (rec) { kbApplyRef.current(rec); })
          : null;
        // ② 路由装上就打一条：用来区分"埋点没生效（HMR 没推上来）"和"键真的没到页面"
        trace('key', 'info', 'key-router-ready', { count: Object.keys(router.map).length, termKeys: resolvedKeys('view.terminal'), shellChords: shellChords.length });
        var pending = null;        // 已按下的和弦前缀
        var lastFire = { id: '', t: 0, evT: null };   // 重复触发护栏（见下）
        function clearPending() {
          pending = null;
          if (chordTimerRef.current) { clearTimeout(chordTimerRef.current); chordTimerRef.current = null; }
        }
        // 哪些命令吃重复触发护栏：**切换类**（按一下翻转一次）。同一次物理按键被投递两次时，
        // 它们会"开一下又立刻关" = 用户眼里的"按了没反应"（Ctrl+` 呼不出终端就是这个形态）。
        // ⚠ 不能对所有命令一刀切：真实用户（和 E2E 探针）完全可能在 200ms 内连按两次 Ctrl+N 建两个文件，
        //   那种"连按"必须照常生效 —— 判据放在"两次事件的时间戳是否几乎相同"上（见下）。
        var TOGGLE_CMDS = { 'view.terminal': 1, 'view.explorer': 1, 'view.quickOpen': 1, 'view.search': 1, 'view.commands': 1, 'view.problems': 1, 'view.keybindings': 1 };
        function fire(id, via, evTime) {
          var e = keyEntry(id);
          if (!e) return;
          // 重复触发护栏：**同一次按键被投递两次** → 丢弃第二次。
          // 判据 = 时间窗口（400ms，人不可能这么快按第二次）**且** 两次事件的时间戳几乎相同（≤30ms）
          // ⇒ 后者把"真的连按两下"放行（§6 78：轨迹里的 `ts` 是后端收报时间，同批共享同一毫秒，不能拿它判时序；
          //    这里用 event.timeStamp 在本页计时，不受 800ms 去抖批量上报影响）。
          // ⚠ v1.5.31 的护栏只有 100ms **且不看时间戳**：既窄（真机双投递几十~两百 ms 会漏过）
          //   又可能误伤真连按 —— 这正是"Ctrl+` 还是呼不出终端"没被兜住的原因（2026-09-21 用户第三次报障）。
          var guarded = !!TOGGLE_CMDS[id];
          var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          var evT = (typeof evTime === 'number' && isFinite(evTime)) ? evTime : null;
          var gap = now - lastFire.t;
          var evGap = (evT === null || lastFire.evT === null) ? null : (evT - lastFire.evT);
          var sameEvent = (evGap === null) ? true : (evGap <= 30);
          if (guarded && lastFire.id === id && gap < 400 && sameEvent) {
            lastFire.t = now;
            trace('key', 'warn', 'shortcut-duplicate-ignored', { id: id, gapMs: Math.round(gap), evGapMs: evGap === null ? null : Math.round(evGap) });
            return;
          }
          // 用 event.timeStamp 判"两次事件是不是同一次按键"：它不受 800ms 去抖批量上报影响
          // （轨迹里的 `ts` 是后端收报时间，同批共享同一毫秒，不能拿它判时序，§6 78）
          var prevGap = (lastFire.id === id) ? gap : null;
          lastFire = { id: id, t: now, evT: evT };
          trace('key', 'info', 'shortcut', { id: id, keys: (via || resolvedKeys(id)), prevGapMs: prevGap === null ? null : Math.round(prevGap) });
          var impl = KEY_IMPL[id];
          if (impl) { impl(); return }
          // ⚠ 命令分发也必须走"每渲染刷新"的指针：本 effect 只在 [keysRev] 变化时重订阅，
          //   直接调组件内的 runCommandById 会拿到**挂载那一刻**的闭包（里面的 tabs 是空数组），
          //   表现成"命令跑了但什么都没发生"（2026-09-21 回归实测：Ctrl+K U 关闭已保存 = 空操作）。
          if (e.cmd && CMD_RUN) CMD_RUN(e.cmd);
        }
        // ② 键位诊断埋点（2026-09-22）：之前只有"命中成功"才写轨迹，导致"键没到页面"和
        //    "到了但没匹配上"在日志里长得一模一样 —— 用户报 Ctrl+` 三次都没定位就是栽在这。
        //    这里只钉三类事实，且**只对带 Ctrl/Alt 的键**、同一 (msg,chord) 1s 内只记一条：
        //      · shortcut-prevented  键到了页面，但已被别的处理器 defaultPrevented（我们让路了）
        //      · shortcut-nokey      键到了，但算不出键位名（IME/Dead 等）
        //      · shortcut-unmatched  键到了、没被拦、注册表里没有这个键位（或键位被解绑）
        //    meta 里带上当前 view.terminal 的生效键位与焦点目标，一眼能看出问题在哪一层。
        var keyDiag = { k: '', t: 0 };
        var rawDiag = { k: '', t: 0 };   // 原始按键埋点的 1s 节流
        function tagOf(el) {
          if (!el || !el.tagName) return '';
          var cn = '';
          try { cn = String(el.className || '') } catch (err) { cn = '' }
          cn = cn.split(' ')[0];
          return el.tagName.toLowerCase() + (cn ? '.' + cn : '');
        }
        function traceKeyDiag(msg, e, extra) {
          if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
          var chord = chordOfEvent(e) || '(空)';
          var k = msg + '|' + chord;
          var now = Date.now();
          if (keyDiag.k === k && now - keyDiag.t < 1000) return;
          keyDiag.k = k; keyDiag.t = now;
          var meta = { code: String(e.code || ''), key: String(e.key || ''), chord: chord, termKeys: resolvedKeys('view.terminal') };
          if (extra) for (var kk in extra) meta[kk] = extra[kk];
          trace('key', 'info', msg, meta);
        }
        function onKeyDown(e) {
          // 快捷键设置页正在录键 → 全局路由让路（否则录 Ctrl+B 会顺手把侧栏关掉）
          if (KEYS_RECORDING) return;
          // ② 反引号原始埋点（收窄版）：这个键在部分机器上会被输入法的底层键盘钩子吞掉
          //    （2026-09-22 实测：Ctrl+` 在页面里只剩 Control、Edge 里同样如此 → 钩子级吞键，与本应用无关）。
          //    留这条窄埋点：下次再报"Ctrl+` 没反应"，轨迹里有没有这一条就能直接分清
          //    「键根本没到页面」和「到了但没匹配上」，不必再猜。
          var rawCode = String(e.code || '');
          var rawKey = String(e.key || '');
          if (rawCode === 'Backquote' || rawKey === '`' || rawKey === '~' || Number(e.keyCode || 0) === 192) {
            var rawNow = Date.now();
            if (rawDiag.k !== rawKey || rawNow - rawDiag.t >= 1000) {
              rawDiag.k = rawKey; rawDiag.t = rawNow;
              trace('key', 'info', 'keydown-backquote', { code: rawCode, key: rawKey, ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, repeat: !!e.repeat, composing: !!e.isComposing, dp: !!e.defaultPrevented, target: tagOf(e.target) });
            }
          }
          // e.repeat：按住不放会重复触发，切换类快捷键（Ctrl+`、Ctrl+B、Ctrl+P…）会开一下又关一下，
          // 表现成"按了没反应" → 一律忽略重复键（VSCode 同样不响应 repeat）
          if (e.isComposing || e.repeat) return;
          if (e.defaultPrevented) { traceKeyDiag('shortcut-prevented', e, { target: tagOf(e.target) }); return; }
          var step = chordOfEvent(e);
          if (!step) { traceKeyDiag('shortcut-nokey', e, { target: tagOf(e.target) }); return; }
          var n = normalizeChord(step);
          // 铁律②：壳刚通过全局快捷键送过同一个键位 → 这条原生事件不再重复处理
          if (shellChordRef.current.chord === n && Date.now() - shellChordRef.current.t < 300) return;
          var full = pending ? (pending + ' ' + step) : step;
          var nFull = normalizeChord(full);
          // ¹ 和弦第二步（或"按了前缀却接着按了别的键"→ 先按单键处理）
          if (pending) {
            if (router.map[nFull]) { clearPending(); e.preventDefault(); e.stopPropagation(); fire(router.map[nFull], full, e.timeStamp); return }
            clearPending();
          }
          // ² 和弦前缀（Ctrl+K …）
          if (router.prefixes[n]) {
            e.preventDefault(); e.stopPropagation();
            pending = n;
            chordTimerRef.current = setTimeout(clearPending, 1500);
            return;
          }
          // ³ 普通键位
          if (router.map[n]) { e.preventDefault(); e.stopPropagation(); fire(router.map[n], step, e.timeStamp); return }
          // ④ 键到了最底层还没人认领 → 记一条（这就是"按了完全没反应"那一类的事实证据）
          traceKeyDiag('shortcut-unmatched', e, { target: tagOf(e.target), keyCount: Object.keys(router.map).length });
        }
        window.addEventListener('keydown', onKeyDown, true);
        return function () {
          window.removeEventListener('keydown', onKeyDown, true);
          if (typeof offShellHotkey === 'function') offShellHotkey();
          if (typeof offBrowserKey === 'function') offBrowserKey();
          if (typeof offBrowserEvt === 'function') offBrowserEvt();
          if (typeof offBrowserAction === 'function') offBrowserAction();
          if (chordTimerRef.current) { clearTimeout(chordTimerRef.current); chordTimerRef.current = null; }
        };
      }, [keysRev]);

      // ③ 命令面板数据：命令表（静态注册；结构预留插件命令扩展，现不实现）
      // **键位不在这里写死** —— 命令面板/操作组显示键位一律走 keyHint('file.save') 这类查询，
      // 数据源 = KEYMAP（见 §「键位注册表」），这样改键位后提示会跟着变，也不会再出现
      // "界面写着 Ctrl+N、实际没实现"的谎报（2026-09-21 用户报障）。
      function commandList() {
        var list = [
          { id: 'file.openFile', title: '打开文件…', cat: '文件', icon: '📂', keywords: 'open file ctrl+o 打开 文件',
            run: openFileViaDialog },
          { id: 'file.openFolder', title: '打开文件夹…', cat: '文件', icon: '📂', run: openFolder },
          { id: 'file.save', title: '保存', cat: '文件', icon: '💾', keywords: 'save ctrl+s',
            run: function () { var b = editorBridgeRef.current; if (b && b.save) b.save(); else setStatusText('没有可保存的文件'); } },
          { id: 'file.saveAll', title: '全部保存', cat: '文件', icon: '💾', keywords: 'save all ctrl+k s',
            run: function () { var b = editorBridgeRef.current; if (b && b.saveAll) b.saveAll(); } },
          { id: 'file.saveAs', title: '另存为…', cat: '文件', icon: '💾', keywords: 'save as ctrl+shift+s 另存为 副本',
            run: saveAsViaDialog },
          // ⑤ 语言智能：这些能力（monaco TS worker 提供）本来就在跑，之前只是没有入口
          { id: 'editor.gotoDefinition', title: '转到定义', cat: '编辑器', icon: '🎯', keywords: 'definition f12 goto 定义 跳转',
            run: function () { var b = editorBridgeRef.current; if (b && b.gotoDefinition) b.gotoDefinition(); else setStatusText('没有打开的编辑器'); } },
          { id: 'editor.outline', title: '转到文件中的符号…', cat: '编辑器', icon: '🔖', keywords: 'outline symbol ctrl+shift+o 符号 大纲',
            run: function () { runEditorAction('editor.action.quickOutline'); } },
          { id: 'editor.rename', title: '重命名符号', cat: '编辑器', icon: '✏️', keywords: 'rename f2 重命名',
            run: function () { runEditorAction('editor.action.rename'); } },
          { id: 'editor.format', title: '格式化文档', cat: '编辑器', icon: '🧹', keywords: 'format shift+alt+f 格式化',
            run: function () { runEditorAction('editor.action.formatDocument'); } },
          { id: 'editor.deleteLines', title: '删除行', cat: '编辑器', icon: '🗑', keywords: 'delete line shift+delete 删除 行',
            run: function () { runEditorAction('editor.action.deleteLines'); } },
          { id: 'editor.hover', title: '显示悬停提示（类型信息）', cat: '编辑器', icon: 'ℹ️', keywords: 'hover 悬停 类型 文档',
            run: function () { runEditorAction('editor.action.showHover'); } },
          { id: 'editor.inlineSuggest', title: '内联建议（AI 补全，Alt+\\）', cat: '编辑器', icon: '✨', keywords: 'inline suggestion ghost copilot alt+\\ 补全 ai 建议',
            run: function () { runEditorAction('editor.action.inlineSuggest.trigger'); } },
          { id: 'editor.nextProblem', title: '下一个问题（诊断）', cat: '视图', icon: '⏭', keywords: 'problem marker f8 next 问题 诊断',
            run: function () { runEditorAction('editor.action.marker.next'); } },
          { id: 'editor.prevProblem', title: '上一个问题（诊断）', cat: '视图', icon: '⏮', keywords: 'problem marker f8 prev 问题 诊断',
            run: function () { runEditorAction('editor.action.marker.prev'); } },
          { id: 'view.problems', title: '显示问题面板（错误/警告）', cat: '视图', icon: '⚠️', keywords: 'problems diagnostics ctrl+shift+m 问题 诊断 错误 警告',
            run: function () { setOverlay('problems'); } },
          { id: 'view.terminal', title: '切换集成终端', cat: '视图', icon: '🖥', keywords: 'terminal shell console ctrl+` 终端 命令行',
            run: function () { setTermOpen(function (v) { return !v; }); } },
          { id: 'term.new', title: '新建终端', cat: '视图', icon: '🖥', keywords: 'new terminal ctrl+shift+` 新建 终端',
            run: newTerminal },
          { id: 'file.close', title: '关闭当前标签', cat: '文件', icon: '✕', keywords: 'close tab ctrl+w',
            run: function () { if (activePath) closeTab(activePath); } },
          { id: 'file.reopenClosed', title: '重新打开已关闭的标签', cat: '文件', icon: '↩️',
            keywords: 'reopen closed undo close tab ctrl+shift+t', run: reopenClosedTab },
          // ⑮ 标签三件套（VSCode 里这一族既在标签右键菜单里，也在命令面板里）
          { id: 'file.closeOthers', title: '关闭其他标签', cat: '文件', icon: '✕',
            keywords: 'close others 关闭 其他 标签 tab',
            run: function () { if (activePath) closeOthers(activePath); } },
          { id: 'file.closeRight', title: '关闭右侧所有标签', cat: '文件', icon: '✕',
            keywords: 'close to the right 关闭 右侧 标签 tab',
            run: function () { if (activePath) closeRight(activePath); } },
          { id: 'file.closeSaved', title: '关闭已保存的标签', cat: '文件', icon: '✕',
            keywords: 'close saved ctrl+k u 关闭 已保存 标签 tab',
            run: closeSaved },
          { id: 'file.closeAll', title: '全部关闭', cat: '文件', icon: '✕',
            keywords: 'close all ctrl+k w 关闭 全部 标签 tab',
            run: closeAll },
          { id: 'file.keepOpen', title: '保持打开（把预览标签转正）', cat: '文件', icon: '📌',
            keywords: 'keep open keep editor preview ctrl+k enter 保持 打开 预览 转正 临时',
            run: function () { promoteTab(activePath); } },
          { id: 'file.togglePin', title: '固定 / 取消固定标签', cat: '文件', icon: '📌',
            keywords: 'pin unpin pinned toggle tab ctrl+k shift+enter 固定 取消固定 钉住 标签',
            run: function () { togglePinTab(activePath); } },
          { id: 'file.copyPath', title: '复制路径', cat: '文件', icon: '📋',
            keywords: 'copy path clipboard 复制 路径',
            run: function () { copyTabPath(activePath, false); } },
          { id: 'file.copyRelPath', title: '复制相对路径', cat: '文件', icon: '📋',
            keywords: 'copy relative path clipboard 复制 相对 路径',
            run: function () { copyTabPath(activePath, true); } },
          { id: 'file.revealInExplorer', title: '在文件资源管理器中显示', cat: '文件', icon: '🗂',
            keywords: 'reveal in explorer folder alt+shift+r ctrl+k r 显示 定位 资源管理器 文件夹',
            run: function () { revealInExplorer(revealTarget()); } },
          // 图片预览的缩放（对应 VSCode 内置 media-preview 的 imagePreview.zoomIn / zoomOut 两条命令；
          // VSCode 里它们没有默认键位，只在图片预览为活动编辑器时出现在命令面板 —— 我们同样不占键位）
          { id: 'image.zoomIn', title: '图片：放大', cat: '视图', icon: '🔍',
            keywords: 'image zoom in 图片 放大 预览 preview',
            run: function () { var b = editorBridgeRef.current; if (b && b.mediaZoom) b.mediaZoom(1); } },
          { id: 'image.zoomOut', title: '图片：缩小', cat: '视图', icon: '🔍',
            keywords: 'image zoom out 图片 缩小 预览 preview',
            run: function () { var b = editorBridgeRef.current; if (b && b.mediaZoom) b.mediaZoom(-1); } },
          { id: 'image.zoomFit', title: '图片：适应窗口', cat: '视图', icon: '⤢',
            keywords: 'image zoom fit whole 图片 适应 窗口 原始大小 preview',
            run: function () { var b = editorBridgeRef.current; if (b && b.mediaZoom) b.mediaZoom(0); } },
          // ⑫ 文件树三件套（VSCode 里也都在命令面板里）
          // ⑲ 新建走**内联输入**（VSCode 手感），目标层级 = 当前聚焦的树节点（见 startNewEntry）
          { id: 'file.newFile', title: '新建文件…', cat: '文件', icon: '📄', keywords: 'new file create 新建 文件 ctrl+n',
            run: function () { startNewEntry('file', treeSel); } },
          { id: 'file.newFolder', title: '新建文件夹…', cat: '文件', icon: '📁', keywords: 'new folder mkdir 新建 文件夹 目录',
            run: function () { startNewEntry('dir', treeSel); } },
          { id: 'file.renameEntry', title: '重命名（当前文件）…', cat: '文件', icon: '✏️', keywords: 'rename f2 重命名 改名',
            run: function () {
              if (!activePath) { setStatusText('没有打开的文件'); return; }
              promptRename({ name: String(activePath).split('\\').pop(), path: activePath, type: 'file' });
            } },
          { id: 'file.deleteEntry', title: '删除（当前文件）…', cat: '文件', icon: '🗑', keywords: 'delete remove 删除 移除',
            run: function () {
              if (!activePath) { setStatusText('没有打开的文件'); return; }
              deleteEntry({ name: String(activePath).split('\\').pop(), path: activePath, type: 'file' });
            } },
          { id: 'view.quickOpen', title: '打开文件…', cat: '视图', icon: '🗂', keywords: 'goto quick open ctrl+p', openWith: 'files' },
          { id: 'view.search', title: '在文件中搜索…', cat: '视图', icon: '🔍', keywords: 'find grep ctrl+shift+f', openWith: 'search' },
          // 主题切换条目已按用户要求移除：应用只保留深色（2026-09-17）
          { id: 'view.refresh', title: '刷新工作空间', cat: '视图', icon: '⟳', keywords: 'reload refresh',
            run: function () { setRefreshTick(function (t) { return t + 1; }); refreshOverview(); } },
          { id: 'view.plugins', title: '插件（左侧活动栏）', cat: '视图', icon: '🧩',
            keywords: 'plugin extension panel manage 插件 扩展 面板 管理',
            run: function () { pickActivity('plugins'); } },
          { id: 'view.toggleExplorer', title: '切换文件树显示', cat: '视图', icon: '📁', keywords: 'explorer sidebar tree ctrl+b',
            run: function () { setShowExplorer(function (v) { return !v; }); } },
          { id: 'agent.newChat', title: '新建对话', cat: 'Agent', icon: '💬', keywords: 'new chat session conversation 新对话 新会话 另起',
            run: function () { newChat(); } },
          { id: 'view.changeHistory', title: '查看改动历史（本次会话）', cat: '视图', icon: '🗂', keywords: 'change history diff agent keep undo review 改动 历史 审阅 保留 撤销',
            run: function () { setHistoryOpen(true); } },
          { id: 'view.snapshots', title: '工作区快照（回撤 / 还原）', cat: '视图', icon: '⏱', keywords: 'snapshot backup restore rollback undo timeline local history 快照 回撤 还原 恢复 备份 后悔 时间线',
            run: function () { openSnapshots(); } },
          { id: 'view.snapshotNow', title: '立即创建快照', cat: '视图', icon: '📌', keywords: 'snapshot now backup 立即快照 备份 打点 存档',
            run: function () { snapshotNow(); } },
          { id: 'help.about', title: '关于 天工', cat: '帮助', icon: 'ℹ️', keywords: 'about version keyboard shortcut',
            run: showAbout },
          // 键位系统（2026-09-21）：命令面板入口 + 标签切换（键位注册表要按 id 调它们）
          { id: 'view.commands', title: '命令面板', cat: '视图', icon: '⌨️', keywords: 'command palette ctrl+shift+p f1 命令 面板',
            run: function () { openCommands(); } },
          { id: 'browser.open', title: '打开内置浏览器', cat: '视图', icon: '🌐', keywords: 'browser web open url 浏览器 打开 网页 地址 内置',
            run: function () { openBrowserTab(''); } },
          { id: 'view.keybindings', title: '快捷键设置…', cat: '视图', icon: '⌨', keywords: 'keyboard shortcut keybinding keymap 快捷键 键位 设置 自定义 改键',
            run: function () { openKeybindings(); } },
          { id: 'view.editorSettings', title: '编辑器设置…', cat: '视图', icon: '⚙️', keywords: 'editor settings unicode highlight ambiguous confusable invisible 编辑器 设置 易混淆 特殊字符 高亮 全角 标点',
            run: function () { openEditorSettings(); } },
          { id: 'md.togglePreview', title: 'Markdown：预览 / 源码', cat: '视图', icon: '📖', keywords: 'markdown preview toc outline document 预览 目录 文档 大纲 md',
            run: function () { toggleMdPreview(); } },
          { id: 'view.nextTab', title: '下一个标签', cat: '视图', icon: '→', keywords: 'next tab ctrl+tab 下一个 标签',
            run: function () { activateTab(1); } },
          { id: 'view.prevTab', title: '上一个标签', cat: '视图', icon: '←', keywords: 'previous tab ctrl+shift+tab 上一个 标签',
            run: function () { activateTab(-1); } },
        ];
        return list;
      }
      function fetchCommands() { return Promise.resolve(commandList()); }
      // 按 id 找命令并执行（键盘路由用；openWith 类命令直接开对应面板）
      function runCommandById(id) {
        var list = commandList();
        for (var i = 0; i < list.length; i++) {
          if (list[i].id !== id) continue;
          var cmd = list[i];
          if (cmd.openWith === 'search') { setOverlay(null); setSearchOpen(true); }
          else if (cmd.openWith) { setSearchOpen(false); setOverlay(cmd.openWith); }
          if (cmd.run) { try { cmd.run(); } catch (e) { setStatusText('命令执行失败：' + String((e && e.message) || e)); } }
          return true;
        }
        return false;
      }

      // ③ 快速打开数据：/tree 全量文件（忽略表在 host 过滤），本地 fuzzy
      function fetchFiles() {
        return apiGet('/tree').then(function (r) {
          if (!r || r.error) throw new Error((r && r.error) || 'tree 获取失败');
          if (!r.files) return [];
          return r.files.map(function (f, i) {
            return { name: f.name, path: f.path, _rel: relDisplay(f.path, r.root), _i: i };
          });
        });
      }

      // ⑤ 命令面板 → monaco 动作（经 editorBridge 暴露的 runAction）
      function runEditorAction(id) {
        var b = editorBridgeRef.current;
        if (b && b.runAction) b.runAction(id);
        else setStatusText('没有打开的编辑器');
      }

      // 「关于」的单一来源：命令面板与「操作」组的帮助区块都调它
      // （键位表**从注册表生成**，改过键位后这里显示的就是你改后的 —— 见 KEYMAP）
      function showAbout() {
        function line(ids) {
          return ids.map(function (id) {
            var e = keyEntry(id);
            if (!e) return '';
            var k = resolvedKeys(id);
            return k ? (k + ' ' + e.title) : '';
          }).filter(Boolean).join('\n');
        }
        window.alert(
          '天工 · 自研桌面 IDE（内核 = 完整 DSH 引擎，编辑器 = VS Code Dark/Light Modern 主题）\n\n'
          + '快捷键（VSCode 习惯；可在「设置 → 快捷键」里逐条改）\n'
          + line(['view.commands', 'view.quickOpen', 'view.search', 'view.problems']) + '\n'
          + line(['file.newFile', 'file.save', 'file.saveAll']) + '\n'
          + line(['file.close', 'file.reopenClosed', 'file.closeAll', 'file.closeSaved', 'file.keepOpen', 'file.togglePin', 'file.copyPath']) + '\n'
          + line(['view.nextTab', 'view.prevTab', 'view.explorer', 'view.terminal']) + '\n'
          + line(['editor.askAgent', 'editor.inlineSuggest', 'editor.gotoDefinition', 'editor.outline']) + '\n',
        );
      }

      // ── 左侧「操作」组：菜单式区块（用户要求：区块标题 + 区块内操作）──────────
      // 这里**只做入口**，每一项都调已有实现（和命令面板同一批），不新增功能。
      function actionBlocks() {
        return [
          { title: '文件', items: [
            { icon: '📂', label: '打开文件夹…', title: '选择并打开一个工作空间', disabled: busy, run: openFolder },
            { icon: '📄', label: '新建文件…', keys: keyHint('file.newFile'), title: '在所选文件夹（或工作空间根）里新建文件',
              run: function () { promptNew('file', null); } },
            { icon: '📁', label: '新建文件夹…', keys: keyHint('file.newFolder'), title: '在所选文件夹（或工作空间根）里新建文件夹',
              run: function () { promptNew('dir', null); } },
            { icon: '🗂', label: '快速打开文件…', keys: keyHint('view.quickOpen'), run: function () { closeOverlays(); setSearchOpen(false); setOverlay('files'); } },
            { icon: '💾', label: '保存', keys: keyHint('file.save'), run: function () { var b = editorBridgeRef.current; if (b && b.save) b.save(); else setStatusText('没有可保存的文件'); } },
            { icon: '💾', label: '全部保存', keys: keyHint('file.saveAll'), run: function () { var b = editorBridgeRef.current; if (b && b.saveAll) b.saveAll(); } },
            { icon: '✕', label: '关闭当前标签', keys: keyHint('file.close'), run: function () { if (activePath) closeTab(activePath); } },
            { icon: '↩️', label: '重新打开已关闭的标签', keys: keyHint('file.reopenClosed'), run: reopenClosedTab },
          ] },
          { title: '编辑', items: [
            { icon: '↶', label: '撤销', keys: keyHint('editor.undo'), run: function () { runEditorAction('undo'); } },
            { icon: '↷', label: '重做', keys: keyHint('editor.redo'), run: function () { runEditorAction('redo'); } },
            { icon: '🔍', label: '在文件中查找', keys: keyHint('editor.find'), run: function () { runEditorAction('actions.find'); } },
            { icon: '🎯', label: '转到定义', keys: keyHint('editor.gotoDefinition'), run: function () { var b = editorBridgeRef.current; if (b && b.gotoDefinition) b.gotoDefinition(); else setStatusText('没有打开的编辑器'); } },
            { icon: '🔖', label: '转到文件中的符号…', keys: keyHint('editor.outline'), run: function () { runEditorAction('editor.action.quickOutline'); } },
            { icon: '✏️', label: '重命名符号', keys: keyHint('editor.rename'), run: function () { runEditorAction('editor.action.rename'); } },
            { icon: '🧹', label: '格式化文档', keys: keyHint('editor.format'), run: function () { runEditorAction('editor.action.formatDocument'); } },
            { icon: '✨', label: '内联建议（AI 补全）', keys: keyHint('editor.inlineSuggest'), run: function () { runEditorAction('editor.action.inlineSuggest.trigger'); } },
          ] },
          { title: '查看', items: [
            { icon: '⌨️', label: '命令面板…', keys: keyHint('view.commands'), run: function () { setSearchOpen(false); setOverlay('commands'); } },
            { icon: '🔎', label: '在文件中搜索…', keys: keyHint('view.search'), run: function () { closeOverlays(); setSearchOpen(true); } },
            { icon: '⚠️', label: '问题（错误 / 警告）', keys: keyHint('view.problems'), run: function () { closeOverlays(); setOverlay('problems'); } },
            { icon: '🗂', label: '改动历史（本次会话）', run: function () { setHistoryOpen(true); } },
            { icon: '⏱', label: '工作区快照（回撤 / 还原）', run: openSnapshots },
            { icon: '🖥', label: '集成终端', keys: keyHint('view.terminal'), run: function () { setTermOpen(function (v) { return !v; }); } },
            { icon: '🌐', label: '打开内置浏览器', title: '在中间面板开一个浏览器标签', run: function () { openBrowserTab(''); } },
            { icon: '🧩', label: '插件（左侧活动栏）', run: function () { pickActivity('plugins'); } },
            { icon: '👁', label: '显隐侧边栏', keys: keyHint('view.explorer'), run: function () { setShowExplorer(function (v) { return !v; }); } },
          ] },
          { title: '帮助', items: [
            { icon: '⌨', label: '快捷键设置…', title: '在中间面板里逐条查看 / 修改快捷键', run: openKeybindings },
            { icon: 'ℹ️', label: '关于 天工（含快捷键表）', run: showAbout },
          ] },
        ];
      }

      // ── 左侧「设置」组 ─────────────────────────────────────────────
      // 说明：原来这里有一张「代码导航状态卡片」（CodeNavRow，会请求 /tools-status 列已装语言）。
      // 2026-09-22 用户报障"设置面板下方那一片一直在闪"—— 实测（tools/probe-unicode.mjs）：
      // 父层每 ~5s 一次的 refreshOverview() 会让 React 把**这一格的包裹节点整个换掉**
      // （MutationObserver 抓到 `.dside-codenav` 在同一个 DIV 上 remove→append），卡片随之
      // 重新挂载、重新拉一次状态；块里其它纯对象行与整块都没被换，换成稳定元素引用也照样被换。
      // ⇒ 处置 = 这一格不再放"挂载即产生副作用（发请求）"的组件，改成一行静态说明；
      //   "装了哪些语言组件"这类信息归到【编辑器设置】页（点进去现拉一次，那页不会被反复重挂）。
    // 打开平台设置面板（中栏视图）。2026-10-12「路二」：官方设置那套内容已改挂到主区的 'settings' key，
    // 我们只负责给位置（中栏）与入口（设置面板里的「全部设置…」）—— 内容与各分区都归官方。
    function openSettingsPage() {
      // 中栏标签（用户要的 VSCode 手感）：openTab 对已开的路径只做激活，不会重复开
      openSettingsTab('engine');
    }

    function settingsBlocks() {
        var verLabel = (upd && upd.installed)          ? ('当前版本 v' + upd.installed + (upd.latest && upd.latest.version ? '（更新源 v' + upd.latest.version + '）' : ''))
          : '版本信息不可用（不在应用环境里）';
        // 「代码导航」那一格的说明见下面 items 里的长注释（原状态卡片已撤，改为静态说明）
        return [
          // 设置页入口统一在这儿（2026-10-12 归并）：三个"点开有内容"的都打开中栏标签，内容各归各家
          // （引擎 / 编辑器 / 快捷键）。组名别写"全部设置" —— 会被读成"包含下面所有开关"，但下面那些
          // 外观/标签项是即时生效的开关，不是页面。
          { title: '设置页', items: [
            { icon: '⚙', label: 'harness 相关设置…', title: '在中面板里打开引擎自带的设置页（通用设置 / 模型 / 插件 / Agent 预设）', run: openSettingsPage },
            { icon: '⚙️', label: '编辑器设置…', title: '在中面板里逐项设置编辑器喜好（易混淆字符 / 看不见的字符 / 非 ASCII + 适用范围）', run: openEditorSettings },
            { icon: '⌨', label: '快捷键…', title: '在中面板里一条条查看 / 修改（点「改」后按下新的组合键）', run: openKeybindings },
            { icon: '📜', label: 'Agent 设置…', title: '在中面板里写 Agent 的「铁律」：每轮对话前原样发给它的一段话（可临时停用）', run: openAgentSettings },
          ] },
          { title: '外观', items: [
            { render: h(FontSizeRow, { onApply: function (px) { var b = editorBridgeRef.current; if (b && b.setFontSize) b.setFontSize(px); } }) },
            { icon: '🎨', label: '界面主题：深色（固定）', disabled: true, title: '按你的要求：应用只有深色，不提供切换' },
          ] },
          // ⑮ 标签三件套的开关（对应 VSCode 的 workbench.editor.*，**默认值与 VSCode 一致**）
          { title: '标签', items: [
            { render: h(ToggleRow, {
                icon: '👁', label: '预览模式', value: tabPrefs.preview,
                title: 'VSCode 的 enablePreview（默认开）：在资源管理器里单击文件只在同一个「预览标签」里临时显示（标签名斜体），再单击别的文件就替换它；双击文件或标签、或者一开始编辑，就转成固定标签。关掉它 = 单击即固定打开。',
                onToggle: function (v) { updateTabPrefs({ preview: v }); } }) },
            { render: h(ToggleRow, {
                icon: '🗂', label: '快速打开走预览', value: tabPrefs.fromQuickOpen, disabled: !tabPrefs.preview,
                title: 'VSCode 的 enablePreviewFromQuickOpen（默认关）：Ctrl+P 选中的文件也用预览标签打开（会顶掉上一个预览标签）',
                onToggle: function (v) { updateTabPrefs({ fromQuickOpen: v }); } }) },
            { render: h(ToggleRow, {
                icon: '🛡', label: '跳转保护当前标签', value: !tabPrefs.fromCodeNav, disabled: !tabPrefs.preview,
                title: 'VSCode 的 enablePreviewFromCodeNavigation（默认关）反过来：默认开着 —— 用 F12 / 搜索结果 / 问题面板跳转前，先把当前标签转正，这样它不会被跳转目标顶掉。关掉它 = 当前标签保持预览态，可能被跳转目标替换掉。',
                onToggle: function (v) { updateTabPrefs({ fromCodeNav: !v }); } }) },
            { render: h(ToggleRow, {
                icon: '📌', label: '固定标签收窄成图标', value: tabPrefs.pinnedCompact,
                title: 'VSCode 的 pinnedTabSizing（默认 normal：外观与普通标签相同，只是强制靠左、批量关闭会跳过它）。打开它 = 收窄成只显示图标。',
                onToggle: function (v) { updateTabPrefs({ pinnedCompact: v }); } }) },
            { render: h(ToggleRow, {
                icon: '♻️', label: '重开软件时恢复上次打开的文件', value: tabPrefs.restoreSession,
                title: '关软件时开着的文件（连带**没保存的改动**）都记在本机，下次打开自动装回来；'
                  + '磁盘上已被删掉/移走的文件会自动跳过。关掉它 = 每次打开都是空编辑器。',
                onToggle: function (v) {
                  updateTabPrefs({ restoreSession: v });
                  if (v) {
                    // 刚打开：把"已恢复过"的标记放开，让它立刻按记忆装回来
                    restoredRootRef.current = null;
                    setSessionTick(function (n) { return n + 1; });
                  }
                  trace('ui', 'info', 'session-restore-toggle', { on: !!v });
                } }) },
            { icon: '🖱', label: '标签右键菜单：关闭族 · 保持打开 · 固定', disabled: true,
              title: '在标签上点右键。固定标签不会被 Ctrl+W / 中键关闭（这是 VSCode 的保护行为）；要关就从右键菜单点「关闭」，或先「取消固定」。' },
          ] },
          // ⌨ 快捷键（入口已上移到「设置页」组，这组只留动作与状态）
          { title: '快捷键', items: [
            { icon: '↺', label: '全部恢复默认', title: '把所有改过的键位恢复成出厂默认',
              run: function () {
                resetAllKeyBindings();
                setKeysRev(function (n) { return n + 1; });
                setStatusText('快捷键已全部恢复默认');
              } },
            { icon: '🧾', label: '改过的键位：' + changedKeyCount() + ' 条', disabled: true,
              title: '存在本机（localStorage 的 dside.keys.v1），换台机器不跟随' },
          ] },
          { title: '版本与更新', items: [
            { icon: '🏷', label: verLabel, disabled: true, title: '更新包只发变化的文件，重启后自动应用' },
            { icon: '🔄', label: '检查更新', keys: 'Ctrl+Shift+U', disabled: !(upd && upd.installed), run: checkUpdate },
          ] },
          { title: '代码导航', items: [
            // 【实测定案 · 2026-09-22】这一格原来是「代码导航状态卡片」（h(CodeNavRow)），
            // 它会去请求 /tools-status。实测（tools/probe-unicode.mjs，隔离实例 + CDP）：
            // 父层每 ~5s 一次的 refreshOverview() 会让 React **把这一格的包裹节点整个换掉**
            // （MutationObserver 抓到 `.dside-codenav` 在同一个 DIV 上 remove→append），
            // 于是卡片每隔几秒重新挂载一次、重新拉一次状态 —— 用户看到的就是"安装位置往下
            // 那一片一直在闪"。同一时刻块里其它行（纯对象渲染的）与整块都没有被换，
            // 换成稳定元素引用也照样被换 ⇒ 病根在"这一格会挂载即产生副作用"这条路径上。
            // 处置：这一格不再放"会自己拉数据的组件"，只留一行静态说明（点它去编辑器设置页/
            // 文档），信息从"活动面板里实时拉"改成"写在设置页说明里"。
            // 回归：tools/e2e-startup.mjs P11/P12（12 秒内不重建、零请求）。
            { icon: '🧭', label: '语言组件装在 <数据目录>\\tools\\lsp（用到时 Agent 会问你）', disabled: true,
              title: 'Agent 改代码前会用代码导航查"定义在哪 / 全项目谁在用"。缺哪种语言，它会先问你要不要装（写清装什么包、从哪来、多大），你同意才下载、按官方哈希校验。' },
          ] },
          { title: '诊断', items: [
            { icon: '🧾', label: '使用轨迹日志', disabled: true, title: 'logs\\ide-trace.log（报 bug 时直接读它，不用你复述）' },
            { icon: '💽', label: '工作区快照库', disabled: true, title: 'snapshots\\（每工作空间保留 40 份 / 最多 1GB）' },
          ] },
        ];
      }

      function runCommand(cmd) {
        trace('ui', 'info', 'command-run', { id: cmd.id });
        if (cmd.openWith === 'search') {
          setOverlay(null);
          setSearchOpen(true);
        } else if (cmd.openWith) {
          setSearchOpen(false);
          setOverlay(cmd.openWith);
        } else {
          setOverlay(null);
          setSearchOpen(false);
          restoreFocus();
        }
        if (cmd.run) cmd.run();
      }

      // ── 反悔药：工作区快照（面板 / 差异 / 一键还原）────────────────────
      function openSnapshots() {
        prevFocusRef.current = document.activeElement;
        setSearchOpen(false);
        setOverlay('snapshots');
        trace('ui', 'info', 'snapshot-panel-open', {});
      }

      function snapshotNow() {
        apiPost('/snapshot', { label: '手动快照', reason: 'manual' }).then(function (r) {
          if (r && r.ok) {
            setSnapLast(r.ts);
            setSnapTick(function (n) { return n + 1; });
            setStatusText('已创建快照（' + (r.fileCount || 0) + ' 个文件）');
          } else setStatusText('创建快照失败' + (r && r.code ? ('：' + r.code) : ''));
        });
      }

      // 快照 ↔ 当前磁盘的一项 → 复用 ⑥ 第三刀那套差异浮层（← → / chips 多文件导航）
      function snapReviewItem(it, iso) {
        var rel = String(it.rel || '');
        var name = rel ? rel.split(/[\\/]/).pop() : String(it.path || '').split(/[\\/]/).pop();
        var head = '快照 ' + (iso ? snapTimeText(Date.parse(iso)) : '');
        var status = it.status;
        function body(text, binary, size) {
          if (text !== null && text !== undefined) return text;
          return binary
            ? '（二进制文件，不做文本预览；还原照样有效）'
            : ('（内容太大，不做预览：' + Math.round((size || 0) / 1024) + ' KB）');
        }
        return {
          path: it.path, name: name, isCreate: status === 'added', kind: 'snapshot', snapStatus: status,
          leftTitle: status === 'added' ? (head + ' · 当时还没有这个文件') : (head + ' · 当时的版本'),
          leftText: body(it.leftText, it.leftBinary, it.leftSize),
          rightTitle: status === 'deleted' ? '当前磁盘 · 这个文件已被删掉' : '当前磁盘',
          rightText: body(it.rightText, it.rightBinary, it.rightSize),
        };
      }

      function reviewSnapshot(ts, label, iso) {
        apiGet('/snapshot-diff', { ts: ts }).then(function (r) {
          if (!r || !r.ok) { setStatusText('打不开这份快照' + (r && r.code ? ('：' + r.code) : '')); return; }
          var items = (r.items || []).map(function (it) { return snapReviewItem(it, iso || r.iso); });
          setOverlay(null);
          if (!items.length) { setStatusText('这份快照与当前工作区完全一致，没有可还原的差异'); return; }
          reviewSeqRef.current += 1;
          setReviewReq({ seq: reviewSeqRef.current, items: items, index: 0, kind: 'snapshot', ts: ts, label: label || '' });
          setStatusText('快照差异：改 ' + r.counts.changed + ' · 增 ' + r.counts.added + ' · 删 ' + r.counts.deleted);
          trace('ui', 'info', 'snapshot-review', { ts: ts, count: items.length });
        });
      }

      function restoreSnapshot(ts, label, paths) {
        var subset = !!(paths && paths.length);
        var msg = '把' + (subset ? ('这 ' + paths.length + ' 个文件') : '整个工作区') + '还原到「' + (label || snapTimeText(ts)) + '」那一刻的状态？\n' +
          '\n· 还原前会自动再存一份快照，所以这次还原本身也能再撤回' +
          (subset ? '' : '\n· 快照之后新增的文件会被移到回收目录（不会直接删除）') +
          '\n· 快照没记录的文件（超大 / 读不到）不会被删除或移动' +
          '\n· 编辑器里打开着的文件若内容不一致会弹冲突提示，不会静默覆盖';
        if (!window.confirm(msg)) return;
        apiPost('/snapshot-restore', { ts: ts, paths: subset ? paths : undefined }).then(function (r) {
          if (!r || !r.ok) { setStatusText('还原失败' + (r && r.code ? ('：' + r.code) : '')); return; }
          reviewSeqRef.current += 1;
          setReviewReq({ seq: reviewSeqRef.current, cleared: true });   // 关掉差异浮层（内容已经变了）
          setSnapLast(r.preTs || ts);
          setSnapTick(function (n) { return n + 1; });
          setRefreshTick(function (n) { return n + 1; });
          setStatusText('已还原：恢复 ' + r.restored + ' 个文件'
            + (r.trashed ? ('、移走 ' + r.trashed + ' 个新增') : '')
            + (r.trashSkipped ? '（这份快照没记全，未移动任何新增文件）' : '')
            + (r.failed ? ('、' + r.failed + ' 个失败') : ''));
          trace('ui', 'warn', 'snapshot-restore-done', { ts: ts, restored: r.restored, trashed: r.trashed, failed: r.failed });
        });
      }

      // ③ 搜索结果点击 → 打开/激活 tab 并定位
      function jumpFromSearch(file, line, col) {
        closeOverlays();
        jumpToFile(file, line, col);
      }

      // ⑤ 问题面板点击 → 打开/激活 tab 并定位（path 来自 markers 的 URI，已转成本地路径）
      function jumpFromProblems(path, line, col) {
        closeOverlays();
        jumpToPath(path, line, col, null);
      }

      // ── ⑫ 文件树三件套：新建 / 重命名 / 删除（2026-09-16）──────────────
      // 三个动作都走 host 的同一套闸（工作空间根围栏 · 不覆盖已有内容 · 埋点）；
      // 成功后 bump refreshTick 让树重列（host 的 fs.watch 也会顺带推一次）。
      function treeContext(node, ev) {
        if (node) setTreeSel(node);      // 右键也算"聚焦到这个层级"（Ctrl+N 随后按它新建，VSCode 同款）
        setTreeMenu({ x: ev.clientX, y: ev.clientY, node: node || null });
      }
      function closeTreeMenu() { setTreeMenu(null); }
      // ⑮ 标签右键菜单（复用文件树那个 TreeMenu 组件）
      function tabContext(path, ev) {
        setTabMenu({ x: ev.clientX, y: ev.clientY, path: path });
      }
      function closeTabMenu() { setTabMenu(null); }
      // ⑮ 标签右键菜单 —— 条目与 VSCode 的 EditorTitleContext 对齐（源码 editor.contribution.ts#L393-L408）：
      // 关闭族 5 条 + Keep Open（仅预览，置灰）+ 固定/取消固定。
      // 不适用的条目**置灰**（VSCode 用 precondition 而不是隐藏）；
      // 拆分/移到其他编辑器组、在新窗口打开这些依赖"多编辑器组/多窗口"的能力天工没有，故不给。
      // 复制路径 / 在文件资源管理器中显示：VSCode 这两条**就在编辑器标题右键菜单**里
      // （files/browser/fileActions.contribution.ts:165 与 files/electron-browser/fileActions.contribution.ts:61，
      // 分组 1_cutcopypaste / 2_files）。旧注释写成"属于资源管理器右键菜单、不在这里"，与源码不符（2026-09-29 修正）。
      function tabMenuItems() {
        var path = tabMenu && tabMenu.path;
        var at = path ? findTabIndex(tabs, path) : -1;
        if (at < 0) return [];
        var t = tabs[at], i, others = 0, rightCount = 0;
        for (i = 0; i < tabs.length; i++) {
          if (i === at) continue;
          others += 1;
          if (i > at && !tabs[i].pinned) rightCount += 1;
        }
        var out = [];
        // 菜单里的「关闭」连固定标签也关（VSCode：menu: always close editor, even sticky ones）
        out.push({ label: '关闭', keys: 'Ctrl+W', run: function () { closeTab(path, true); } });
        out.push({ label: '关闭其他', disabled: others === 0, run: function () { closeOthers(path); } });
        out.push({ label: '关闭右侧所有标签', disabled: rightCount === 0, run: function () { closeRight(path); } });
        out.push({ label: '关闭已保存的标签', keys: 'Ctrl+K U', run: closeSaved });
        out.push({ label: '全部关闭', keys: 'Ctrl+K W', run: closeAll });
        out.push({ sep: true });
        out.push({
          label: '保持打开（把预览转正）', keys: 'Ctrl+K Enter', disabled: !t.preview,
          title: t.preview ? '把这个预览标签转成固定标签' : '只有预览标签（斜体）才需要转正',
          run: function () { promoteTab(path); },
        });
        out.push({
          label: t.pinned ? '取消固定' : '固定', keys: 'Ctrl+K Shift+Enter',
          title: t.pinned
            ? '取消固定：回到普通标签（批量关闭将不再跳过它）'
            : '固定：靠左排、批量关闭（关闭其他/右侧/已保存/全部）会跳过它',
          run: function () { setTabPinned(path, !t.pinned); },
        });
        out.push({ sep: true });
        // Markdown 标签：源码 ⇄ 预览（VSCode 的编辑器标题右键菜单里就是 Open Preview / Open Source）
        if (!isPseudoPath(path) && isMarkdownName(t.name)) {
          out.push({
            label: t.mdPreview ? '回到源码（Markdown）' : '打开 Markdown 预览', keys: 'Ctrl+Shift+V',
            run: function () { setTabMdPreview(path, !t.mdPreview); },
          });
        }
        // 路径族两条对浏览器标签不成立：它的"路径"是 browser:// 伪协议，
        // 既没有磁盘路径可复制，也没有文件可以在资源管理器里定位
        if (!isPseudoPath(path)) {
          out.push({ label: '复制路径', keys: keyHint('file.copyPath') || undefined, run: function () { copyTabPath(path, false); } });
          if (typeof window !== 'undefined' && window.anzioShell && window.anzioShell.revealInFolder) {
            out.push({ label: '在文件资源管理器中显示', keys: keyHint('file.revealInExplorer') || undefined, run: function () { revealInExplorer(path); } });
          }
        }
        return out;
      }
      function joinPath(dir, name) {
        return String(dir || '').replace(/[\\/]+$/, '') + '\\' + String(name || '').replace(/^[\\/]+/, '');
      }
      function dirOfNode(node) {
        if (!node) return root;
        if (node.type === 'directory') return node.path;
        return String(node.path).replace(/[\\/][^\\/]*$/, '');
      }
      // 重命名/删除时把对应标签强制关掉（先 dispose 模型，避免 monaco 里留着野 model）
      function forceCloseTab(path) {
        if (editorBridgeRef.current && editorBridgeRef.current.disposeModel) {
          try { editorBridgeRef.current.disposeModel(path); } catch (e) { /* 已释放 */ }
        }
        var remaining = [];
        for (var i = 0; i < tabs.length; i++) if (tabs[i].path !== path) remaining.push(tabs[i]);
        setTabs(remaining);
        if (activePath === path) setActivePath(remaining.length ? remaining[0].path : null);
      }
      // ── 内联新建（VSCode 手感：树里就地出输入框，光标直接落在名字上）──────────────
      // 目标层级规则同 VSCode 的 explorer.newFile：文件夹 → 它自己；文件 → 它所在的目录；
      // 什么都没选 → 工作空间根。规则就一句 `dirOfNode`。
      function startNewEntry(kind, node) {
        closeTreeMenu();
        if (!root) { setStatusText('先打开一个文件夹再新建'); return; }
        // 先把「资源管理器」露出来：VSCode 的 `openExplorerAndCreate` 也是这个顺序
        // （视图不可见时先 `openView(...)` 再等 500ms —— 源码注释 "Give explorer some time to
        // resolve itself"）。不这么做的话，人在「操作/设置」组里按 Ctrl+N 会"什么都没发生"：
        // 内联行虽然设了，但 Explorer 根本没挂载（2026-09-21 回归实测抓到的真问题）。
        if (activity !== 'explorer' || !showExplorer) pickActivity('explorer');
        var dir = dirOfNode(node);
        if (!dir) { setStatusText('找不到目标位置'); return; }
        setInlineNew({ dir: dir, kind: kind });
        trace('ui', 'info', 'tree-new-inline-open', { dir: dir, kind: kind, from: node ? node.path : null });
      }
      function submitInlineNew(name) {
        var cur = inlineNew;
        setInlineNew(null);
        if (!cur) return;
        var full = joinPath(cur.dir, name);
        createEntry(full, cur.kind);
        setTreeSel({ path: full, name: String(full).split('\\').pop(), type: cur.kind === 'dir' ? 'directory' : 'file' });
      }
      function cancelInlineNew() {
        setInlineNew(null);
        trace('ui', 'info', 'tree-new-inline-cancel', {});
      }
      function promptNew(kind, node) {
        // 保留原来的对话框版本（命令面板/右键菜单仍可用它），但**默认走内联**：
        // startNewEntry 才是 Ctrl+N 与标题栏按钮的路径。
        startNewEntry(kind, node);
      }
      function promptRename(node) {
        if (!node) { setStatusText('没有可重命名的文件'); return; }
        closeTreeMenu();
        setNameDialog({
          title: '重命名',
          initial: node.name,
          placeholder: '新名称',
          hint: '原位置：' + relDisplay(node.path, root),
          onSubmit: function (name) { renameEntry(node.path, joinPath(dirOfNode(node), name)); },
        });
      }
      function createEntry(path, kind) {
        setNameDialog(null);
        apiPost('/new-entry', { path: path, kind: kind }).then(function (r) {
          if (r && r.code === 'exists') { setStatusText('已存在同名文件/文件夹，换个名字'); return; }
          if (r && r.error) { setStatusText('新建失败：' + r.error); return; }
          setStatusText('已新建：' + relDisplay(path, root));
          setRefreshTick(function (t) { return t + 1; });
          trace('ui', 'info', 'tree-new-ok', { path: path, kind: kind });
          if (kind === 'file') openTab({ name: String(path).split('\\').pop(), path: path }); // VSCode 同款：新建即打开
        }).catch(function (e) { setStatusText('新建失败：' + String((e && e.message) || e)); });
      }
      function renameEntry(from, to) {
        setNameDialog(null);
        apiPost('/rename', { from: from, to: to }).then(function (r) {
          if (r && r.code === 'exists') { setStatusText('目标已存在，换个名字'); return; }
          if (r && r.error) { setStatusText('重命名失败：' + r.error); return; }
          var opened = null;
          for (var i = 0; i < tabs.length; i++) if (tabs[i].path === from) opened = tabs[i];
          if (opened) {
            var keepOpen = true;
            if (opened.dirty) {
              keepOpen = window.confirm('「' + opened.name + '」有未保存的更改；重命名后标签会按新路径从磁盘重读。继续？');
            }
            forceCloseTab(from);
            if (keepOpen) {
              openTab({ name: String(to).split('\\').pop(), path: to });
              // ⑮ 标签形态跟着走：原来固定/预览的，重命名后还是固定/预览
              if (opened.pinned || opened.preview) {
                setTabs(function (prev) {
                  var out = prev.map(function (t) {
                    return t.path === to
                      ? tabItem(t, { pinned: !!opened.pinned, preview: opened.pinned ? false : !!opened.preview })
                      : t;
                  });
                  return pinFirst(out);
                });
              }
            }
          }
          setStatusText('已重命名：' + relDisplay(to, root));
          setRefreshTick(function (t) { return t + 1; });
          trace('ui', 'info', 'tree-rename-ok', { from: from, to: to });
        }).catch(function (e) { setStatusText('重命名失败：' + String((e && e.message) || e)); });
      }
      function deleteEntry(node) {
        closeTreeMenu();
        if (!node) return;
        var isDir = node.type === 'directory';
        var msg = isDir
          ? '删除文件夹「' + node.name + '」及其全部内容？此操作不可撤销。'
          : '删除「' + node.name + '」？此操作不可撤销。';
        if (!window.confirm(msg)) return;
        apiPost('/delete-file', { path: node.path, recursive: isDir }).then(function (r) {
          if (r && r.error) { setStatusText('删除失败：' + r.error); return; }
          var victims = [];
          for (var i = 0; i < tabs.length; i++) {
            var p = tabs[i].path;
            if (p === node.path || (isDir && p.indexOf(node.path + '\\') === 0)) victims.push(p);
          }
          for (var j = 0; j < victims.length; j++) forceCloseTab(victims[j]);
          setStatusText('已删除：' + relDisplay(node.path, root));
          setRefreshTick(function (t) { return t + 1; });
          trace('ui', 'info', 'tree-delete-ok', { path: node.path, dir: isDir });
        }).catch(function (e) { setStatusText('删除失败：' + String((e && e.message) || e)); });
      }
      function treeMenuItems() {
        var node = treeMenu ? treeMenu.node : null;
        var items = [];
        if (!node) { // 空白处右键 = 对工作空间根操作
          items.push({ label: '新建文件…', run: function () { promptNew('file', null); } });
          items.push({ label: '新建文件夹…', run: function () { promptNew('dir', null); } });
          return items;
        }
        if (node.type !== 'directory') {
          items.push({ label: '打开', run: function () { openTab(node); } });
          // Markdown 右键直接进预览（VSCode 的 explorer/context 里本来就有一条 markdown.showPreview）
          if (isMarkdownName(node.name)) {
            items.push({ label: '打开预览', run: function () { openMarkdownPreview(node.path, node.name); } });
          }
          items.push({ sep: true });
        }
        items.push({ label: '新建文件…', run: function () { promptNew('file', node); } });
        if (node.type === 'directory') items.push({ label: '新建文件夹…', run: function () { promptNew('dir', node); } });
        items.push({ sep: true });
        // ⑮ 路径族放在**资源管理器右键菜单**里（VSCode 就是这么放的：标签右键菜单没有这几条）
        items.push({ label: '复制路径', run: function () { copyTabPath(node.path, false); } });
        items.push({ label: '复制相对路径', run: function () { copyTabPath(node.path, true); } });
        if (typeof window !== 'undefined' && window.anzioShell && window.anzioShell.revealInFolder) {
          items.push({ label: '在文件资源管理器中显示', run: function () { revealInExplorer(node.path); } });
        }
        // ③ VSCode 同款：目录 → 用它自己；文件 → 用它的父目录（见 openTerminalAt 注释）
        items.push({
          label: '在终端中打开',
          run: function () { openTerminalAt(node.type === 'directory' ? node.path : dirnameOf(node.path)); },
        });
        items.push({ sep: true });
        items.push({ label: '重命名…', run: function () { promptRename(node); } });
        items.push({ label: '删除', run: function () { deleteEntry(node); } });
        return items;
      }

      var activeFile = null;
      for (var i = 0; i < tabs.length; i++) if (tabs[i].path === activePath) { activeFile = tabs[i]; break; }

      // ── 「新对话」的当前会话（2026-09-17）──────────────────────────
      // 平台语义：**空会话不进会话列表**（session-controller 的注释写明：blank 会话要等第一条
      // 消息被接受才浮现在列表里，"still reusable by connectWorkspace"）。它没进列表时
      // uiSession 的主视图绑定是 absent（从平台那边读不到 id），所以"新对话"必须自己记住这个
      // id —— 否则点了等于没反应。它一旦被平台接住（用户发出第一条消息），就把当前会话交还。
      var draftState = React.useState(null);
      var draftSession = draftState[0], setDraftSession = draftState[1];
      // ── 当前会话（2026-10-13 对齐 0.2.1）──────────────────────────
      // 0.2.1 把"当前会话"从会话列表快照里**搬走了**（sessions.list 不再有 current 字段），
      // 新家是 uiSession 的主视图绑定：平台导航 uiWorkspace.openSession(id) →
      // sessions.retain(id, {source:'mainView'}) → uiSession.adapter.current 指向它。
      // ⚠ 别再读 listState.current：0.2.1 里恒为 undefined，症状是"点历史会话右栏毫无反应"。
      var uiCurState = React.useState(undefined);
      var uiCurrent = uiCurState[0], setUiCurrent = uiCurState[1];
      var uiOffRef = React.useRef(null);
      var uiDisposedRef = React.useRef(false);
      /** 接上主视图绑定（只接一次）；服务没就绪就返回，等列表下次推送时重试（见下方列表订阅） */
      function attachUiCurrent() {
        if (uiDisposedRef.current || uiOffRef.current) return;
        var src = uiSession.currentSource();
        if (!src) return;
        var update = function () {
          var v = src.getSnapshot ? src.getSnapshot() : null;
          setUiCurrent((v && v.key) || undefined);
        };
        update();
        uiOffRef.current = src.subscribe(update);
      }
      React.useEffect(function () {
        attachUiCurrent();
        return function () {
          uiDisposedRef.current = true;
          var off = uiOffRef.current;
          uiOffRef.current = null;
          if (off) { try { off(); } catch (e) { /* 已释放 */ } }
        };
      }, []);
      var current = draftSession || uiCurrent;
      // 列表订阅只建一次（[] 依赖），它回调里读不到当次渲染的 current → 额外留一个 ref 镜像
      // （同 listStateRef 的用法，给 syncActiveRoot 读）
      var currentRef = React.useRef(undefined);
      currentRef.current = current;
      React.useEffect(function () {
        // 只有当平台真的把这个会话接住（主视图绑定指向它）才把 draft 交还；
        // 别用"byId 里有它就清"—— 空会话往往已经在列表数据里、只是没被渲染出来，
        // 那样会在同一帧里立刻把 draft 清掉（表现为"点了没反应"，2026-09-17 实测踩到）。
        if (draftSession && uiCurrent === draftSession) setDraftSession(null);
      }, [uiCurrent, draftSession]);

      // ── 历史对话（2026-09-17 用户要求）────────────────────────────
      // 默认**收起**（用户原话：没人会时时刻刻盯着历史对话列表），操作栏「🕘 历史对话」展开；
      // 展开后顶部可搜索**全部对话内容** —— 直接用平台自带索引：
      //   sessions.search(q, signal) → { items: [{ sessionId, snippet }], hasMore }
      // （契约："Search the Host's visible message-content index"），片段由平台给，我只负责展示。
      var sessionsOpenState = React.useState(false);
      var sessionsOpen = sessionsOpenState[0], setSessionsOpen = sessionsOpenState[1];
      var sesSearchState = React.useState({ q: '', items: null, hasMore: false, busy: false });
      var sesSearch = sesSearchState[0], setSesSearch = sesSearchState[1];
      var sesSeqRef = React.useRef(0);
      var sesTimerRef = React.useRef(null);
      function runSessionSearch(query) {
        var seq = ++sesSeqRef.current;
        // 搜索走后端：平台的 sessions.search **没有 host 侧实现**（inspect 服务目录里没有任何
        // 会话检索服务，实测永远返回空数组），所以由插件 host 半直接读会话日志 —— 见
        // lib/index.js 的 searchSessionLogs 与 /dsh-ide/session-search。
        apiGet('/session-search', { q: query, limit: 40 }).then(function (r) {
          if (seq !== sesSeqRef.current) return;    // 丢弃过期响应（快速输入时）
          var items = (r && r.items) || [];
          setSesSearch({ q: query, items: items, hasMore: !!(r && r.hasMore), busy: false });
          trace('ui', 'info', 'session-search', { q: query, hits: items.length, scanned: (r && r.scanned) || 0 });
        }).catch(function (e) {
          if (seq !== sesSeqRef.current) return;
          setSesSearch({ q: query, items: [], hasMore: false, busy: false });
          trace('ui', 'error', 'session-search-failed', { q: query, error: String((e && e.message) || e) });
        });
      }
      function onSessionSearch(value) {
        var q = String(value == null ? '' : value);
        setSesSearch(function (prev) {
          return { q: q, items: prev.q === q ? prev.items : null, hasMore: false, busy: !!q.trim() };
        });
        if (sesTimerRef.current) clearTimeout(sesTimerRef.current);
        if (!q.trim()) return;                       // 清空 → 回到普通列表
        sesTimerRef.current = setTimeout(function () { runSessionSearch(q.trim()); }, 300);   // 防抖
      }

      // ── 官方会话列表订阅（列表/历史/状态全来自 sessions 服务）──
      React.useEffect(function () {
        if (!sessions) return;
        var update = function () {
          var s = sessions.list.getSnapshot();
          listStateRef.current = s; // ref 镜像同步（旧闭包可读最新）
          setListState(s);
          // ui-session 与 ui-workspace 依赖同一批服务、由引擎定序：它没就绪时这里每次列表推送
          // 都补一次连接（不靠定时器等"加载完"）
          attachUiCurrent();
          // current 一变化就立即上报活动 root（不等 5s 轮询/800ms 兜底：
          // 冷启动恢复、切会话、打开文件夹都在这条路径上秒级收敛）
          syncActiveRoot();
        };
        update();
        return sessions.list.subscribe(update);
      }, []);

      // ── 当前会话绑定订阅（对话快照：nodes + partial 流式）──
      React.useEffect(function () {
        setConv(null);
        setSessionFace(null);
        if (!sessions || !current) return;
        // 轨迹关联：日志带上"当前会话"，否则用户操作与引擎里的 Agent 回合永远对不上号
        try {
          window.__dshTraceCtx = window.__dshTraceCtx || {};
          window.__dshTraceCtx.sessionId = String(current);
        } catch (e) { /* 忽略 */ }
        var binding = sessions.binding(current);
        if (!binding) return;
        setSessionFace(binding.session);
        // 对话来自事件窗口（eventSource），元数据（openState/running）来自会话快照 —— 两边都订阅
        var update = function () {
          var win = binding.eventSource && binding.eventSource.getSnapshot();
          setConv(projectConversation(
            win,
            binding.session.getSnapshot(),
          ));
          // 对话回退："用户已经发出新消息"这件事从**会话事件流**里认（唯一信号，不去猜 DOM）
          rewindWatchWindow(win, current);
        };
        update();
        var offs = [];
        if (binding.eventSource && binding.eventSource.subscribe) offs.push(binding.eventSource.subscribe(update));
        offs.push(binding.session.subscribe(update));
        return function () {
          for (var i = 0; i < offs.length; i++) { try { offs[i](); } catch (e) { /* 已释放 */ } }
        };
      }, [current]);

      // ── 工作空间/插件概览（host 半 /init；不再轮询 agent 消息）──
      // root 跟随"当前会话的工作目录"（多工作空间下不能死取注册表第一个：
      // 2026-09-02 切空间后文件树不变的根因，host 曾用 list[0]）
      var lastRootRef = React.useRef(null);
      // 启动期的"工作空间记忆"（见 writeLastRoot 注释）：bootRootRef = 本次开机画面该显示哪个目录；
      // bootAppliedRef = 已经把它报给 host；bootConfirmedRef = 平台的会话已经接上来（= 以后一切照旧）
      var bootRootRef = React.useRef(readLastRoot());
      var bootAppliedRef = React.useRef(false);
      var bootConfirmedRef = React.useRef(false);
      function syncActiveRoot() {
        var snap = listStateRef.current || listState;
        // 当前会话认 current（draft 或平台主视图），**别再读 snap.current**：0.2.1 里它恒为
        // undefined，症状是切会话后活动根/文件树不跟随（一直停在上一次那个目录）
        var curId = currentRef.current;
        var curS = (curId && snap && snap.byId) ? snap.byId[curId] : null;
        var cwd = curS && curS.cwd ? curS.cwd : null;
        if (!cwd) { lastRootRef.current = null; return; }
        // 平台已经把会话接到我们记忆的那个工作空间里（含子目录）→ 记忆使命结束
        if (bootRootRef.current && pathUnderRoot(cwd, bootRootRef.current)) {
          bootConfirmedRef.current = true;
          bootRootRef.current = null;
        } else if (bootRootRef.current && bootAppliedRef.current && !bootConfirmedRef.current) {
          // 还没接上来：此刻的 cwd 是"上次遗留的旧会话"，别让它把画面纠正回 00WORK
          return;
        }
        if (cwd === lastRootRef.current) return;
        try { window.__dshTraceCtx = window.__dshTraceCtx || {}; window.__dshTraceCtx.root = cwd; } catch (e) { /* 忽略 */ }
        lastRootRef.current = cwd; // 乐观记值，失败回退重试
        writeLastRoot(cwd);
        apiPost('/active-root', { path: cwd }).catch(function () { lastRootRef.current = null; });
      }
      /** 把"当前该用哪个根"推给 host（host 的 /init、文件树、搜索、快照都按它走） */
      function pushRoot(path) {
        if (!path) return;
        lastRootRef.current = path;
        apiPost('/active-root', { path: path }).catch(function () { /* host 不认就退回默认 */ });
      }
      /** 认下一个新工作空间根（用户主动打开文件夹 / 开机记忆）：写记忆 + 上报 + 换树 */
      function adoptRoot(path) {
        if (!path) return;
        bootRootRef.current = null;
        bootConfirmedRef.current = true;
        setRoot(path);
        writeLastRoot(path);
        pushRoot(path);
        trace('ui', 'info', 'active-root', { path: path, source: 'adopt' });
      }
      // 开机第一件事：画面立刻显示"上次真正在用的目录"，并把它推给 host（赶在文件树首次
      // 拉目录之前）。注册表里已经没有那个目录时（被删过），退到平台自己的选择。
      React.useEffect(function () {
        var r = bootRootRef.current;
        if (!r) return;
        bootAppliedRef.current = true;
        setRoot(r);       // 状态先摆上：树第一次渲染就是对的，不用等网络往返
        pushRoot(r);      // 再推给 host（注册表还没就绪时 host 可能仍回退，届时下面会重试）
        trace('ui', 'info', 'boot-active-root', { path: r });
        var tries = 0;
        var timer = null;
        var settle = function () {
          if (rootIsRegistered(r)) {
            adoptRoot(r);
            trace('ui', 'info', 'boot-root-confirmed', { path: r, tries: tries });
          } else {
            bootRootRef.current = null;
            bootConfirmedRef.current = true;
            setRoot(null);
            refreshOverview();
            trace('ui', 'info', 'boot-root-missing', { path: r });
          }
        };
        // workspaces 列表可能比本组件晚就绪 → 最多重试 9 次（≈4.5s）
        (function attempt() {
          tries += 1;
          var ready = false;
          try { ready = !!(workspaces && workspaces.list && workspaces.list.getSnapshot().items.length); } catch (e) { ready = false; }
          if (ready || tries >= 9) { settle(); return }
          if (timer) clearTimeout(timer);
          timer = setTimeout(attempt, 500);
        })();
        return function () { if (timer) clearTimeout(timer); };
      }, []);
      /** 这个根是不是"还落在工作空间注册表里"（host 只认注册过的根） */
      function rootIsRegistered(path) {
        try {
          var items = workspaces && workspaces.list ? workspaces.list.getSnapshot().items : null;
          if (!items || !items.length) return true;   // 列表还没到：先当成有（别把用户挡在外面）
          for (var i = 0; i < items.length; i++) if (pathUnderRoot(path, items[i].path) || pathUnderRoot(items[i].path, path)) return true;
        } catch (e) { return true; }
        return false;
      }
      function refreshOverview() {
        if (root) syncActiveRoot();
        apiGet('/init').then(function (r) {
          if (!r) return;
          // ⚠ 开机第一件事是把**记住的**工作空间显示出来，而 host 那边此刻只来得及回退到
          //   workspaceRegistry.list()[0]（= 最早建的那个，用户看到的就是"先闪一下 00WORK"）。
          //   所以在平台会话接上来之前，别用 /init 的 root 覆盖画面（2026-09-22 修）。
          if (r.root && !(bootRootRef.current && !bootConfirmedRef.current)) setRoot(r.root);
          else if (r.root) trace('ui', 'info', 'boot-root-keep', { boot: bootRootRef.current, init: r.root });
          if (r.plugins) setPlugins(r.plugins);
          var shown = bootRootRef.current || r.root;
          setStatusText(shown ? ('工作空间: ' + shown) : '未选择工作空间');
        }).catch(function () {});
      }

      React.useEffect(function () { refreshOverview(); }, []);
      React.useEffect(function () {
        var timer = setInterval(refreshOverview, 5000);
        return function () { clearInterval(timer); };
      }, []);

      // ── 资源管理器自动刷新（2026-09-16）────────────────────────────────
      // 平台没有文件系统事件；host 半用 node:fs.watch 维护一个变更计数，这边每
      // 1.2s 只读那个整数（几十字节），**变了才重列目录** —— Agent 建/改的文件、
      // 外部编辑器、git 操作都不用再手点 ⟳ 刷新。页面隐藏时跳过（与 ⑥ 的 /stat
      // 轮询同策略），恢复可见时 focus 立即补一次。
      React.useEffect(function () {
        var stopped = false;
        var lastRev = -1;
        function pollFsRev() {
          if (document.hidden) return;
          apiGet('/fs-rev').then(function (r) {
            if (stopped || !r || typeof r.rev !== 'number') return;
            if (lastRev === -1) { lastRev = r.rev; return; }   // 首次只记基线（挂载时已列过目录）
            if (r.rev !== lastRev) {
              lastRev = r.rev;
              setFsRev(function (v) { return v + 1; });
              // 磁盘一动就刷一条（曾占全量日志 4 万条）：60s 一条 + 被压掉的次数即可
              traceEvery('fs-change-refresh', 60000, 'ui', 'info', 'fs-change-refresh', { rev: r.rev });
            }
          }).catch(function () { /* 后端没起来就下一轮再试 */ });
        }
        var timer = setInterval(pollFsRev, 1200);
        pollFsRev();
        window.addEventListener('focus', pollFsRev);
        return function () { stopped = true; clearInterval(timer); window.removeEventListener('focus', pollFsRev); };
      }, []);

      // ⑤ 状态栏诊断计数：2s 读一次 monaco 的 markers（数量没变就不 setState，避免无谓重渲染）
      React.useEffect(function () {
        var timer = setInterval(function () {
          var monaco = window.monaco;
          if (!monaco || !monaco.editor) return;
          var all = monaco.editor.getModelMarkers({}) || [];
          var e = 0, w = 0;
          for (var i = 0; i < all.length; i++) {
            if (all[i].severity === 8) e += 1;
            else if (all[i].severity === 4) w += 1;
          }
          setProbCounts(function (prev) { return (prev.e === e && prev.w === w) ? prev : { e: e, w: w }; });
        }, 2000);
        return function () { clearInterval(timer); };
      }, []);

      // ── ⑥ 第二/三刀：改动清单（会话事件 → 按「轮次 × 文件」归组；保留/撤销状态本地记）──
      // 2026-10-19 改口径（用户实测）：清单的**待处理集合跨轮合并**，对齐 VSCode chat 的 working set。
      // 旧行为只看最近一轮 —— 上一轮没点保留/撤销的改动，下一轮一产生改动就从列表里消失，
      // 只剩「历史 N 轮」里能找到；同文件被下一轮再改，上一轮连撤销都做不了（对不上文本）。
      // 现在：未处理的改动不分轮，同一文件连续几轮的编辑并成一条；历史视图仍按轮展示（回看语义）。
      // 轮次 = 事件里的 data.turn（实测 1,2,3… 单调递增），ordinal 是窗口内的序号（第 1..N 轮）。
      var changeStatusRef = React.useRef({});   // 当前会话的 `${path}|${首条事件 seq}` -> 'kept' | 'undone'
      // ── 审阅状态必须落盘（2026-09-17 用户实测：点完「全部保留」，重开软件又让重审一遍）──
      // changeStatusRef 只是内存 ref，而面板每次都是从会话事件重新投影的 → 不落盘就等于白点。
      // 形态 { [sessionId]: { 'path|首条seq': 'kept'|'undone' } }：键跟着"待处理链的起点"走，
      // 不用 ordinal（窗口相对序号，会变）。旧键 `turn|path` 在分组时自动迁移，老记录不丢。
      // localStorage 落在应用数据目录里，重启不丢。
      var CHANGE_STATUS_KEY = 'dside.changeStatus.v1';
      function loadChangeStore() {
        try {
          var o = JSON.parse(window.localStorage.getItem(CHANGE_STATUS_KEY) || '{}');
          return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
        } catch (e) { return {}; }
      }
      function saveChangeStore(store) {
        try {
          var keys = Object.keys(store), cur = statusSessionRef.current;
          for (var i = 0; i < keys.length - 30; i++) {     // 只留最近 30 个会话，防无限增长
            if (keys[i] !== cur) delete store[keys[i]];
          }
          window.localStorage.setItem(CHANGE_STATUS_KEY, JSON.stringify(store));
        } catch (e) { /* 拿不到存储：降级成纯内存态，功能不崩 */ }
      }
      var changeStoreRef = React.useRef(null);
      if (!changeStoreRef.current) changeStoreRef.current = loadChangeStore();
      var statusSessionRef = React.useRef(null);
      // 会话切换（含冷启动）时把该会话的状态接进来：changeStatusRef 直接指向 store 里的子对象，
      // 之后写入即改到 store，保存时整份落盘。放在分组之前 → 首帧就是正确状态，不会闪一下。
      if (statusSessionRef.current !== current) {
        var sid0 = current || '';
        if (!sid0) {
          changeStatusRef.current = {};          // 还没选中会话：用临时对象，别往 store 里塞空桶
        } else {
          if (!changeStoreRef.current[sid0]) changeStoreRef.current[sid0] = {};
          changeStatusRef.current = changeStoreRef.current[sid0];
        }
        statusSessionRef.current = sid0;
      }
      function persistChangeStatus() { saveChangeStore(changeStoreRef.current); }
      var createProbeRef = React.useRef({});   // `${path}|${time}` -> null(查询中) | true(本次新建) | false
      var changeTickState = React.useState(0);
      var bumpChangeTick = changeTickState[1];
      var reviewSeqRef = React.useRef(0);
      var reviewReqState = React.useState(null);
      var reviewReq = reviewReqState[0], setReviewReq = reviewReqState[1];
      var historyState = React.useState(false);
      var historyOpen = historyState[0], setHistoryOpen = historyState[1];

      function changeKeyOf(g) {
        if (g && g.changeKey) return g.changeKey;
        var e0 = (g && g.entries && g.entries[0]) || null;
        return ((g && g.path) || '') + '|' + (e0 && e0.seq !== undefined ? e0.seq : '');
      }

      var roundList = [];      // 轮次（最新一轮在前）—— 历史视图用
      var allGroups = [];      // 全部轮次的文件组（新→旧），"本次会话"口径用
      var pendingGroups = [];  // 待处理集合（跨轮合并；同一文件连续未处理的编辑并成一条）
      var groupIndex = {};     // changeKey -> 组 / 合并条目（审阅浮层、差异标签回调用）
      (function () {
        var raw = (conv && conv.changes) || [];
        if (!raw.length) return;
        var migrated = false;   // 旧状态键（turn|path）迁移过 → 渲染后补一次落盘
        var byTurn = {}, order = [];
        for (var i = 0; i < raw.length; i++) {
          var c = raw[i];
          var tk = c.turn || '';
          var round = byTurn[tk];
          if (!round) {
            round = byTurn[tk] = { turn: tk, groups: [], byPath: {}, seq: c.seq, time: c.time };
            order.push(round);
          }
          var g = round.byPath[c.path];
          if (!g) {
            g = { key: tk + '|' + c.path, path: c.path, name: basenameOf(c.path), turn: tk, entries: [] };
            round.byPath[c.path] = g;
            round.groups.push(g);
          }
          g.entries.push(c);
        }
        order.sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });   // 事件序 = 时间序
        for (var o = 0; o < order.length; o++) order[o].ordinal = o + 1;
        roundList = order.slice().reverse();
        if (roundList.length) roundList[0].isCurrent = true;
        for (var r = 0; r < roundList.length; r++) {
          var rl = roundList[r];
          for (var k = 0; k < rl.groups.length; k++) {
            var gg = rl.groups[k];
            var e0 = gg.entries[0];
            gg.kind = e0.kind;
            gg.roundLabel = rl.ordinal;
            // 状态键 = 文件 + 这一组首条事件的 seq；跨轮合并后键就是"链的起点"，不随轮次变化
            gg.changeKey = gg.path + '|' + (e0.seq === undefined ? '' : e0.seq);
            gg.chainKeys = [gg.changeKey];
            // 旧键迁移：`turn|path` -> `path|首条 seq`（老用户的保留/撤销记录不能因为换键就复活）
            var oldKey = (gg.turn || '') + '|' + gg.path;
            if (oldKey !== gg.changeKey && changeStatusRef.current[oldKey] !== undefined) {
              if (changeStatusRef.current[gg.changeKey] === undefined) {
                changeStatusRef.current[gg.changeKey] = changeStatusRef.current[oldKey];
              }
              delete changeStatusRef.current[oldKey];
              migrated = true;
            }
            if (oldKey !== gg.changeKey) {
              for (var q0 = 0; q0 < gg.entries.length; q0++) {
                var ok0 = oldKey + '#' + gg.entries[q0].key;
                if (changeStatusRef.current[ok0] === undefined) continue;
                var nk0 = gg.changeKey + '#' + gg.entries[q0].key;
                if (changeStatusRef.current[nk0] === undefined) changeStatusRef.current[nk0] = changeStatusRef.current[ok0];
                delete changeStatusRef.current[ok0];
                migrated = true;
              }
            }
            // write 类：birthMs >= 调用时间-5s → 是这次新建；false → 文件本来就有（无变化覆写）
            var probeKey = e0.path + '|' + e0.time;
            var probed = e0.kind === 'write' ? createProbeRef.current[probeKey] : undefined;
            gg.isCreate = e0.kind === 'create' || probed === true;
            gg.ambiguousWrite = e0.kind === 'write' && probed === false;
            gg.status = changeStatusRef.current[changeKeyOf(gg)] || '';
            // 逐块进度（⑥ 第四刀）：一个文件被改了多处时，清单行上显示"处理了几处/共几处"，
            // 不然你只知道这个文件动过，不知道还有几处没看
            gg.hunkCount = gg.kind === 'hunk' && gg.entries ? gg.entries.length : 0;
            gg.hunkDone = 0;
            if (gg.hunkCount > 1) {
              if (gg.status) gg.hunkDone = gg.hunkCount;      // 整个文件已保留/已撤销 → 全部算处理过
              else {
                for (var q = 0; q < gg.entries.length; q++) {
                  if (changeStatusRef.current[changeKeyOf(gg) + '#' + gg.entries[q].key]) gg.hunkDone += 1;
                }
              }
            }
            // 审阅用展示文本：新建=整份内容；编辑=各 hunk 片段（平台给的是 hunk 级 before/after）
            if (e0.kind !== 'hunk') {
              gg.before = '';
              gg.after = e0.after;
            } else {
              var bs = [], as = [];
              for (var m = 0; m < gg.entries.length; m++) {
                bs.push(gg.entries[m].before || '');
                as.push(gg.entries[m].after || '');
              }
              gg.before = bs.join('\n⋯\n');
              gg.after = as.join('\n⋯\n');
            }
            allGroups.push(gg);
            groupIndex[gg.changeKey] = gg;
          }
        }

        // ── 待处理集合：跨轮合并（2026-10-19，对齐 VSCode chat 的 working set）──
        // 同一文件连续未处理的编辑并成一条；中间夹着已处理（保留/撤销）就断开、从下一轮重起一条 ——
        // 否则这一条会跨过结算点，撤销时把已经认过的改动一起翻掉。
        // 整文件写入（write）不参与合并：before 只有 null，跟片段拼不出可信对照，各自单独成条。
        var byPath = {}, pathOrder = [];
        for (var p1 = 0; p1 < allGroups.length; p1++) {
          var g1 = allGroups[p1];
          if (!byPath[g1.path]) { byPath[g1.path] = []; pathOrder.push(g1.path); }
          byPath[g1.path].push(g1);
        }
        function makeChain(chain) {
          if (chain.length === 1) return chain[0];   // 单轮一条：用它自己，键与状态都不变
          var first = chain[0];
          var ents = [], keys = [], ords = [], bs = [], as = [], x, y;
          for (x = 0; x < chain.length; x++) {
            keys.push(chain[x].changeKey);
            ords.push(chain[x].roundLabel);
            for (y = 0; y < chain[x].entries.length; y++) ents.push(chain[x].entries[y]);
          }
          for (x = 0; x < ents.length; x++) { bs.push(ents[x].before || ''); as.push(ents[x].after || ''); }
          var out = {
            // 审阅身份键与状态键分开：状态键 = 链起点（结算时链上每一轮都要写），
            // 身份键 = 整条链自己（否则历史里点"第 1 轮"会跟这条链撞成同一份审阅内容）
            key: 'chain|' + first.changeKey,
            reviewKey: 'chain|' + first.changeKey,
            changeKey: first.changeKey, chainKeys: keys,
            path: first.path, name: first.name, turn: first.turn,
            kind: 'hunk', isCreate: !!first.isCreate, ambiguousWrite: false,
            entries: ents, status: '', rounds: ords,
            before: bs.join('\n⋯\n'), after: as.join('\n⋯\n'),
            hunkCount: ents.length, hunkDone: 0,
          };
          for (x = 0; x < ents.length; x++) {
            if (changeStatusRef.current[out.changeKey + '#' + ents[x].key]) out.hunkDone += 1;
          }
          groupIndex[out.reviewKey] = out;
          return out;
        }
        for (var p2 = 0; p2 < pathOrder.length; p2++) {
          var pathGroups = byPath[pathOrder[p2]];
          pathGroups.sort(function (x, y) {
            return (x.entries[0].seq || 0) - (y.entries[0].seq || 0);   // 事件序 = 时间序
          });
          var chain = [];
          for (var p3 = 0; p3 < pathGroups.length; p3++) {
            var lg = pathGroups[p3];
            if (lg.kind !== 'hunk' || lg.status) {
              if (chain.length) { pendingGroups.push(makeChain(chain)); chain = []; }
              if (!lg.status && lg.kind !== 'hunk') pendingGroups.push(lg);   // 未处理的整份写入单独成条
              continue;
            }
            chain.push(lg);
          }
          if (chain.length) pendingGroups.push(makeChain(chain));
        }
        // 最近改动的排最上面
        pendingGroups.sort(function (x, y) {
          var xs = x.entries && x.entries.length ? x.entries[x.entries.length - 1].seq : 0;
          var ys = y.entries && y.entries.length ? y.entries[y.entries.length - 1].seq : 0;
          return (ys || 0) - (xs || 0);
        });
        if (migrated) persistChangeStatus();   // 迁移只在渲染期发生一次，这里补落盘
      })();

      // write 类改动的新建判定（异步：一次 /stat 查创建时间，结果缓存进 ref）
      React.useEffect(function () {
        for (var i = 0; i < allGroups.length; i++) {
          var e0 = allGroups[i].entries[0];
          if (e0.kind !== 'write') continue;
          var pk = e0.path + '|' + e0.time;
          if (createProbeRef.current[pk] !== undefined) continue;
          createProbeRef.current[pk] = null;   // 占位（null = 查询中），防重复请求
          (function (key, t, p) {
            apiGet('/stat', { path: p }).then(function (st) {
              createProbeRef.current[key] = !!(st && st.exists && typeof st.birthMs === 'number'
                && st.birthMs >= (t || 0) - 5000);
              bumpChangeTick(function (v) { return v + 1; });
              trace('ui', 'info', 'change-create-probe', { path: p, isNew: createProbeRef.current[key] });
            }).catch(function () { createProbeRef.current[key] = false; });
          })(pk, e0.time, e0.path);
        }
      });

      // 这个文件的改动处理完了（文件级状态已落）→ 关掉它的差异标签。
      // VSCode 同款：Keep/Undo 处理完，那个 diff 编辑器就关了，不留"已处理"的空壳。
      // 标签 id 用的是审阅身份键：跨轮合并的条目是 chain|…，单轮组就是自己（见 reviewItemOf）。
      function closeReviewTabsOf(stateKey, g) {
        var ids = [stateKey];
        if (g && g.reviewKey && g.reviewKey !== stateKey) ids.push(g.reviewKey);
        for (var i = 0; i < ids.length; i++) {
          try { closeTab(REVIEW_SCHEME + ids[i], true, true) } catch (e) { /* 标签可能早关了 */ }
        }
      }
      function closeReviewTabIfDone(changeKey) {
        if (!changeStatusRef.current[changeKey]) return;
        closeReviewTabsOf(changeKey, groupIndex[changeKey] || null);
      }
      function markChange(g, status) {
        // 跨轮合并的条目 = 一条链：链上每一轮都要一起记，否则链尾那轮还会以"未处理"冒出来
        var ks = (g && g.chainKeys) || [changeKeyOf(g)];
        for (var i = 0; i < ks.length; i++) {
          changeStatusRef.current[ks[i]] = status;
          closeReviewTabIfDone(ks[i]);
        }
        closeReviewTabsOf(changeKeyOf(g), g);   // 合并条目的差异标签（身份键）也一并退场
        persistChangeStatus();   // 落盘：撤销状态同样要能扛住重开软件
        bumpChangeTick(function (n) { return n + 1; });
      }

      // 逐块审阅：把一个文件组的 hunk 拆成"块"（⑥ 第四刀）。
      // 只有多块的编辑才有意义 —— 单块时"撤销这个文件"就是撤它，不必多一层
      // 一块的状态：文件级优先（整个文件已撤销/已保留），否则看这一块自己的（⑥ 第四刀）
      function hunkStatusAt(changeKey, hunkKey) {
        var st = changeStatusRef.current;
        return st[changeKey] || st[changeKey + '#' + hunkKey] || '';
      }
      function hunkEntriesOf(g) {
        if (g.kind !== 'hunk' || !g.entries || g.entries.length < 2) return null;
        var ck = changeKeyOf(g), out = [], i;
        for (i = 0; i < g.entries.length; i++) {
          var k = String(g.entries[i].key);
          out.push({
            key: k, before: g.entries[i].before || '', after: g.entries[i].after || '',
            status: hunkStatusAt(ck, k),
          });
        }
        return out;
      }

      // 一个文件组 → 审阅队列里的一项（左右两侧的展示文本）
      function reviewItemOf(g) {
        return {
          path: g.path, name: g.name, isCreate: !!g.isCreate, kind: g.kind, status: g.status, turn: g.turn || '',
          changeKey: g.reviewKey || changeKeyOf(g), hunks: hunkEntriesOf(g),
          leftTitle: g.isCreate
            ? '改动前（文件不存在）'
            : (g.kind === 'write' ? '改动前（内容未知 · 整文件写入）' : '改动前（片段）'),
          leftText: g.before,
          rightTitle: '改动后（Agent 写入）',
          rightText: g.after,
        };
      }

      // ⑥ 重做（2026-10-10）：点清单行 → 在编辑器区开一个**差异标签**（VSCode 的 "Open Changes in Diff Editor" 同款）。
      // ⚠ 不再用自造浮层，也不顺带打开文件本身：审阅的产物就是一个标签，关掉即结束。
      function reviewGroups(groups, startIndex) {
        var list = [];
        for (var i = 0; i < (groups || []).length; i++) if (groups[i] && groups[i].path) list.push(groups[i]);
        if (!list.length) return;
        var items = [];
        for (var j = 0; j < list.length; j++) items.push(reviewItemOf(list[j]));
        var idx = Math.max(0, Math.min(items.length - 1, startIndex || 0));
        reviewSeqRef.current += 1;
        setReviewReq({ seq: reviewSeqRef.current, items: items, index: idx });
        trace('ui', 'info', 'change-review-queue', { count: items.length, from: items[idx].path });
        openTab({ name: items[idx].name, path: REVIEW_SCHEME + items[idx].changeKey });
      }

      function reviewChange(g) { reviewGroups([g], 0); }

      function rollbackByPath(path) {
        // 优先撤"待处理"的那条（跨轮合并后的链）；没有待处理的才回落到单轮记录
        for (var i = 0; i < pendingGroups.length; i++) {
          if (pendingGroups[i].path === path) { rollbackChange(pendingGroups[i]); return; }
        }
        for (var j = 0; j < allGroups.length; j++) {
          if (allGroups[j].path === path) { rollbackChange(allGroups[j]); return; }
        }
        setStatusText('找不到这个文件的改动记录（可能已切走会话）');
      }

      // 撤销 = 把磁盘还原成 Agent 动手之前的样子。两道安全闸：
      //   ① 只对"磁盘内容仍等于 Agent 产出"的文件生效（否则可能盖掉后续改动）；
      //   ② 写回/删除都带版本令牌（平台 replaceIfVersion 守卫）。
      // 跨轮合并的条目 = 一条链，entries 已按时间升序排好，倒序回放正好一路退回最初。
      // done 用于「全部撤销」把多个文件串起来：同一文件可能同时有整份写入与局部编辑两条待处理，
      // 并发写盘会互相盖掉（版本令牌也会打架），所以一条落定才动下一条。
      function rollbackChange(g, done) {
        var fin = function () { if (typeof done === 'function') done(); };
        var ents = (g && g.entries) || [];
        var onlyHunk = true, i0;
        for (i0 = 0; i0 < ents.length; i0++) {
          if (ents[i0].kind === 'write' || ents[i0].kind === 'create') onlyHunk = false;
        }
        if (!onlyHunk && g.kind !== 'write') {
          // 写入与编辑混在一条链里：before 只有 null，没法逐段回放 → 绝不猜，交给人
          setStatusText('这个文件既有整份写入又有局部编辑，无法自动撤销 —— 已打开差异供你手动处理');
          trace('ui', 'warn', 'change-undo-skip', { path: g.path, reason: 'mixed-write-hunk' });
          reviewChange(g);
          fin();
          return;
        }
        apiGet('/read-file', { path: g.path }).then(function (d) {
          if (!d || d.error || typeof d.content !== 'string') {
            markChange(g, 'undone');
            setStatusText('撤销：磁盘上已经没有这个文件了');
            fin();
            return;
          }
          if (g.kind === 'write') {
            // 整文件写入：只有确认"这个文件是这次调用新建的"才允许用删除撤销。
            // 判定来自 birthMs 探测（见上面 createProbeRef），查不出/不是新建一律不动磁盘
            var pk = ents[0].path + '|' + ents[0].time;
            if (createProbeRef.current[pk] !== true) {
              setStatusText('这个文件在 Agent 写它之前就已存在（删除会误伤）—— 已打开差异供你手动处理');
              trace('ui', 'warn', 'change-undo-skip', { path: g.path, reason: 'not-confirmed-create' });
              reviewChange(g);
              fin();
              return;
            }
            apiPost('/delete-file', { path: g.path, baseVersion: d.version }).then(function (r) {
              if (r && r.error) {
                setStatusText('撤销失败: ' + r.error);
                trace('ui', 'error', 'change-undo-failed', { path: g.path, error: String(r.error) });
                fin();
                return;
              }
              afterRollback(g);
              fin();
            }).catch(function () { fin(); });
            return;
          }
          if (g.isCreate) {
            apiPost('/delete-file', { path: g.path, baseVersion: d.version }).then(function (r) {
              if (r && r.error) {
                setStatusText('撤销失败: ' + r.error);
                trace('ui', 'error', 'change-undo-failed', { path: g.path, error: String(r.error) });
                fin();
                return;
              }
              afterRollback(g);
              fin();
            }).catch(function () { fin(); });
            return;
          }
          // 编辑：把每处改动的 newText 还原成 oldText（倒序 + 要求唯一匹配，匹配不上就交给人）
          var text = d.content;
          var entries = ents.slice().reverse();
          for (var i = 0; i < entries.length; i++) {
            var nt = entries[i].after, ot = entries[i].before || '';
            if (typeof nt !== 'string' || !nt) continue;
            var at = text.indexOf(nt);
            if (at < 0 || text.indexOf(nt, at + 1) >= 0) {
              setStatusText('这个文件在 Agent 改动后又被改过，无法自动撤销 —— 已打开差异供你手动处理');
              trace('ui', 'warn', 'change-undo-skip', { path: g.path, reason: at < 0 ? 'not-found' : 'ambiguous' });
              reviewChange(g);
              fin();
              return;
            }
            text = text.slice(0, at) + ot + text.slice(at + nt.length);
          }
          apiPost('/write-file', { path: g.path, content: text, baseVersion: d.version }).then(function (r) {
            if (r && r.error) {
              setStatusText('撤销失败: ' + r.error);
              trace('ui', 'error', 'change-undo-failed', { path: g.path, error: String(r.error) });
              fin();
              return;
            }
            afterRollback(g);
            fin();
          }).catch(function () { fin(); });
        }).catch(function () { fin(); });
      }

      function afterRollback(g) {
        markChange(g, 'undone');
        setStatusText('已撤销 Agent 对这个文件的改动: ' + g.name);
        trace('ui', 'warn', 'change-undo-ok', { path: g.path, create: !!g.isCreate });
      }

      // ── ⑥ 第四刀：逐块保留 / 撤销 ─────────────────────────────────
      // 撤销一块 = 只把这一块的 newText 换回 oldText 再写盘，同文件其它块一律不动。
      // 安全闸与整文件撤销同一套：读回当前内容 + 版本令牌写回；匹配不上（找不到 / 多处命中）
      // 就拒绝自动改，绝不猜位置 —— 猜错会改坏用户别的代码。
      function groupByChangeKey(key) {
        // groupIndex 同时收单轮组与跨轮合并条目（合并条目的键 = 链起点）
        return groupIndex[key] || null;
      }
      // 块状态变了 → 让浮层重建：走 reviewReq 这条**唯一**的跨组件通道
      //（外层 effect 盯 seq 变化，然后自己重算 diffState）。seq 变则差异编辑器重建、滚动回顶部。
      // ⚠ 别在这里调 setDiff —— 那是外层组件的 state，本层够不着，一调就 ReferenceError
      //（2026-10-10 实测：点「保留」当场抛，动作生效了但浮层不刷新）。跨层只能靠 props 递信号。
      function refreshReview() {
        setReviewReq(function (prev) {
          if (!prev || !prev.items || !prev.items.length) return prev;
          var items = [], i;
          for (i = 0; i < prev.items.length; i++) {
            var g = groupByChangeKey(prev.items[i].changeKey);
            items.push(g ? reviewItemOf(g) : prev.items[i]);
          }
          reviewSeqRef.current += 1;
          return {
            seq: reviewSeqRef.current, items: items, index: prev.index || 0,
            kind: prev.kind, ts: prev.ts, label: prev.label,
          };
        });
      }
      function markHunk(reviewKey, hunkKey, status) {
        var g = groupByChangeKey(reviewKey);
        // 块状态必须写在"状态键"（链起点）上：合并条目的审阅身份键是 chain|…，跟状态表不是一套
        var base = g ? changeKeyOf(g) : reviewKey;
        changeStatusRef.current[base + '#' + hunkKey] = status;
        // 这个文件的块全处理完了 → 连文件级一起标上，清单里该行退场
        //（与 VSCode 一致：处理完的文件从改动列表消失，不留"2/2"这种句尾）
        if (g && g.entries && g.entries.length && !changeStatusRef.current[base]) {
          var all = true, i;
          for (i = 0; i < g.entries.length; i++) {
            if (!changeStatusRef.current[base + '#' + String(g.entries[i].key)]) { all = false; break; }
          }
          if (all) {
            // 整条链一起记（跨轮合并的条目可能横跨几轮，只标链起点会让链尾那轮又冒出来）
            var ks = g.chainKeys || [base];
            for (i = 0; i < ks.length; i++) {
              changeStatusRef.current[ks[i]] = 'kept';
              closeReviewTabIfDone(ks[i]);
            }
            closeReviewTabsOf(base, g);   // 合并条目的差异标签（身份键）也退场
          }
        }
        persistChangeStatus();
        trace('ui', 'info', 'change-hunk-mark', { key: base, hunk: hunkKey, status: status });
        bumpChangeTick(function (v) { return v + 1; });
        refreshReview();
      }
      function rollbackHunk(changeKey, hunkKey) {
        var g = groupByChangeKey(changeKey);
        if (!g) { setStatusText('找不到这一处改动的记录（可能已切走会话）'); return; }
        var entry = null, i;
        for (i = 0; i < g.entries.length; i++) {
          if (String(g.entries[i].key) === String(hunkKey)) { entry = g.entries[i]; break; }
        }
        if (!entry) { setStatusText('找不到这一处改动的记录'); return; }
        if (g.isCreate || g.kind === 'write') { setStatusText('这个文件是整份写入的，没有逐块可撤'); return; }
        var nt = entry.after, ot = entry.before || '';
        if (typeof nt !== 'string' || !nt) { setStatusText('这一处改动没有可回退的内容'); return; }
        apiGet('/read-file', { path: g.path }).then(function (d) {
          if (!d || d.error || typeof d.content !== 'string') {
            setStatusText('撤销：磁盘上读不到这个文件了');
            return;
          }
          var at = d.content.indexOf(nt);
          if (at < 0 || d.content.indexOf(nt, at + 1) >= 0) {
            setStatusText('这一处改动在磁盘上已经对不上了（文件后来被改过），没有自动撤销');
            trace('ui', 'warn', 'change-undo-hunk-skip', { path: g.path, key: hunkKey, reason: at < 0 ? 'not-found' : 'ambiguous' });
            return;
          }
          var text = d.content.slice(0, at) + ot + d.content.slice(at + nt.length);
          apiPost('/write-file', { path: g.path, content: text, baseVersion: d.version }).then(function (r) {
            if (r && r.error) {
              setStatusText('撤销失败: ' + r.error);
              trace('ui', 'error', 'change-undo-hunk-failed', { path: g.path, key: hunkKey, error: String(r.error) });
              return;
            }
            trace('ui', 'warn', 'change-undo-hunk-ok', { path: g.path, key: hunkKey });
            markHunk(changeKey, hunkKey, 'undone');
            setStatusText('已撤销这一处改动: ' + g.name);
          });
        });
      }

      // 保留/撤销按「组」走：行内 = 一个文件，轮次头 = 一轮，面板头 = 待处理（跨轮合并后的队列）
      function keepGroups(groups, label) {
        var list = groups || [];
        var n = 0, keys = [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].status === 'undone') continue;   // 已撤销的不翻案
          var ks = list[i].chainKeys || [changeKeyOf(list[i])];
          for (var m = 0; m < ks.length; m++) {
            changeStatusRef.current[ks[m]] = 'kept';
            keys.push(ks[m]);
          }
          n += 1;
        }
        persistChangeStatus();   // 落盘（不落盘 = 重开软件又让重审一遍）
        bumpChangeTick(function (v) { return v + 1; });
        for (var j = 0; j < keys.length; j++) closeReviewTabIfDone(keys[j]);   // 处理完的差异标签一并退场
        setStatusText('已保留 ' + n + ' 项改动' + (label ? '（' + label + '）' : ''));
        trace('ui', 'info', 'change-keep-all', { count: n, scope: label || '待处理' });
      }

      function undoGroups(groups, label) {
        var list = [];
        for (var i = 0; i < (groups || []).length; i++) if (groups[i].status !== 'undone') list.push(groups[i]);
        if (!list.length) return;
        var idx = list.length - 1;
        // 倒序 + 串行：后改的先还原；同一文件可能同时有"整份写入"与"编辑"两条待处理，
        // 并发写盘会互相盖掉（版本令牌也会打架），所以一条落定才动下一条。
        function next() {
          if (idx < 0) {
            setStatusText('已撤销 ' + list.length + ' 项改动' + (label ? '（' + label + '）' : ''));
            return;
          }
          var g = list[idx];
          idx -= 1;
          rollbackChange(g, function () { next(); });
        }
        setStatusText('正在撤销 ' + list.length + ' 项改动…');
        trace('ui', 'warn', 'change-undo-all', { count: list.length, scope: label || '待处理' });
        next();
      }

      function keepAllChanges() { keepGroups(historyOpen ? allGroups : pendingGroups, historyOpen ? '本次会话' : '待处理'); }
      function undoAllChanges() { undoGroups(historyOpen ? allGroups : pendingGroups, historyOpen ? '本次会话' : '待处理'); }

      // ⑥ 编辑器 → Agent：把「选中代码 + 当前文件 + 诊断」拼好的消息发进当前会话，
      // 并把右侧切到 Agent 页（VSCode 的 Ctrl+I 也是"就地提问、答案立刻可见"）
      function onAskAgent(message, ctx) {
        if (!sessionFace) {
          setStatusText('还没有会话：请先点击"📂 打开文件夹"新建');
          return;
        }
        sendMessage(message);
        setStatusText('已发给 Agent：' + ((ctx && (ctx.rel || ctx.path)) || '当前文件')
          + (ctx && ctx.sel ? ' 第 ' + ctx.sel.startLine + '-' + ctx.sel.endLine + ' 行' : ''));
      }

      function sendMessage(text) {
        if (!sessionFace) {
          setStatusText('还没有会话：请先点击"📂 打开文件夹"新建');
          return;
        }
        trace('ui', 'info', 'agent-send', { len: text.length });
        // 对话回退：发出新消息 = **定局**（口径）—— 先把分隔条落下，这段话才会成为"退回来的那一段之后的新开始"
        rewindCommitIfPending();
        snapAuto('发送前');            // 反悔药：先记下"这一轮 Agent 动手之前"的工作区状态
        sessionFace.prompt([{ type: 'text', text: text }], 'queue').then(function (r) {
          if (r && !r.ok) {
            var msg = (r.error && r.error.message) || JSON.stringify(r.error);
            setStatusText('发送失败: ' + msg);
            trace('ui', 'error', 'agent-send-failed', { error: String(msg) });
          }
        }).catch(function (e) {
          var msg = String((e && e.message) || e);
          setStatusText('发送失败: ' + msg);
          trace('ui', 'error', 'agent-send-failed', { error: msg });
        });
      }

      function cancelTurn() {
        if (!sessionFace) return;
        sessionFace.cancel().then(function (r) {
          if (r && !r.ok) setStatusText('停止失败: ' + ((r.error && r.error.message) || ''));
        }).catch(function () {});
      }

      // 「新对话」：在**当前工作空间**里新建（或复用）一个空白对话并切过去
      // （2026-09-17 用户要求加这个入口）。背景：以前根本没有"新对话" —— AgentPanel 的
      // onNewSession 被错绑成 openFolder（点一次弹目录选择框）。
      // 正确姿势（查 client 契约 + 实测）：导航能力在 **uiWorkspace** 服务上（`workspaces` 只是注册表）：
      //   workspaces.create({path}) 幂等拿到 workspaceId → uiWorkspace.connectWorkspace(id)
      //   = "复用或新建该工作空间的空白会话" → 返回 sessionId → uiWorkspace.openSession(id) 切过去
      //   （老注释那句"必须自己 sessions.open(id)"在 0.2.1 已失效：该方法没了，平台导航即全部）
      // ⚠ 别用 uiWorkspace.startSession()：那是 ui-workspace 自家 UI 的导航，跟本插件自绘面板的
      //   current 是两套（实测：会话建出来了、IDE 里既没切过去也不在列表里）。
      function newChat() {
        if (!uiWorkspace || !workspaces) { setStatusText('工作空间服务不可用，无法新建对话'); return; }
        if (!root) { setStatusText('还没有工作空间：先选一个文件夹'); openFolder(); return; }
        setStatusText('正在新建对话…');
        workspaces.create({ path: root }).then(function (ws) {
          return uiWorkspace.connectWorkspace(ws.workspaceId);
        }).then(function (sessionId) {
          if (sessionId) {
            // ① 自己记住它（空会话可能没被列表渲染出来，见 draftSession 注释）
            setDraftSession(sessionId);
            // ② 平台导航切过去 —— 0.2.1 里这一步就是"设为当前会话"的全部（内部会 retain 成主视图，
            //    uiSession.adapter.current 随后推给右栏）。旧写法里的 sessions.open(id) 已不存在
            //    （调用直接抛错，之前只靠上面的 draft 兜住显示）
            try { uiWorkspace.openSession(sessionId); } catch (e) { /* 平台导航失败不影响 IDE */ }
          }
          setHistoryOpen(false);
          setStatusText('已新建对话');
          trace('ui', 'info', 'new-chat', { root: root, sessionId: sessionId || null });
          // 新会话成为 current 后 root 上报要跟着走（同 openFolder）：稍后再刷一次
          setTimeout(function () { refreshOverview(); }, 800);
        }).catch(function (e) {
          var msg = String((e && e.message) || e);
          setStatusText('新建对话失败: ' + msg);
          trace('ui', 'error', 'new-chat-failed', { root: root, error: msg });
        });
      }

      // 打开文件（VSCode `workbench.action.files.openFile`）：走天工壳的原生"打开文件"对话框。
      // 平台侧只有 pickDirectory、没有选文件的能力，所以这件事只能由壳提供（见 dsh-desktop/main.js）。
      function openFileViaDialog() {
        var sh = (typeof window !== 'undefined') ? window.anzioShell : null;
        if (!sh || !sh.pickFile) { setStatusText('当前环境不支持「打开文件」（应用内可用）'); return; }
        sh.pickFile().then(function (r) {
          if (!r || !r.ok) {
            if (!r || r.code !== 'canceled') setStatusText('打开文件失败：' + ((r && (r.message || r.code)) || 'unknown'));
            return;
          }
          var p = String(r.path || '');
          if (!p) return;
          openTab({ name: p.split(/[\\/]/).pop(), path: p });   // 工作区外的文件照样能开（编辑器没有沙箱，2026-09-22 钉死）
          setStatusText('已打开：' + p);
          trace('ui', 'info', 'open-file-dialog', { path: p });
        });
      }

      // 另存为（VSCode `workbench.action.files.saveAs`）：原生保存对话框拿目标路径 → 把**当前缓冲区正文**
      // 写过去 → 打开新标签、关掉原标签，原文件磁盘内容不动 —— 等价于 VSCode 的"编辑器重定向到新 URI"。
      function saveAsViaDialog() {
        if (!activePath) { setStatusText('没有可另存的文件'); return; }
        var sh = (typeof window !== 'undefined') ? window.anzioShell : null;
        if (!sh || !sh.pickSavePath) { setStatusText('当前环境不支持「另存为」（应用内可用）'); return; }
        var get = draftGetterRef.current;
        var info = get ? get(activePath) : null;
        // 目标已存在时的覆盖确认由原生对话框负责（同 VSCode）；这里不传 baseVersion = 不做版本校验，
        // 因为"另存为"的语义就是写一个新文件，与磁盘上的旧版本无关。
        if (!info || typeof info.text !== 'string') { setStatusText('当前编辑器不支持另存为（只有文本文件可以）'); return; }
        var src = activePath;
        sh.pickSavePath(src).then(function (r) {
          if (!r || !r.ok) {
            if (!r || r.code !== 'canceled') setStatusText('另存为失败：' + ((r && (r.message || r.code)) || 'unknown'));
            return;
          }
          var target = String(r.path || '');
          if (!target) return;
          apiPost('/write-file', { path: target, content: info.text }).then(function (w) {
            if (w && w.error) {
              setStatusText('另存为失败：' + w.error);
              trace('ui', 'error', 'save-as-failed', { path: target, error: String(w.error) });
              return;
            }
            openTab({ name: target.split(/[\\/]/).pop(), path: target });
            closeTab(src, true, true);   // force=连固定标签也关；noConfirm=正文已写进新文件，不该再问"未保存"
            setStatusText('已另存为：' + target);
            trace('ui', 'info', 'save-as', { from: src, to: target });
          });
        });
      }

      // 新建终端（VSCode `workbench.action.terminal.new`）：单终端模型 → 递增 termRev 触发重挂载；
      // cwd 回工作区根（VSCode 新建终端的默认 cwd 也是工作区根）。
      function newTerminal() {
        setTermCwd(null);
        setTermRev(function (n) { return n + 1; });
        setTermOpen(true);
        trace('ui', 'info', 'terminal-new', {});
      }
      function openFolder() {
        if (!uiWorkspace || !workspaces) {
          setStatusText('工作空间服务不可用');
          return;
        }
        setStatusText('请在弹出的窗口中选择文件夹…');
        uiWorkspace.pickDirectory().then(function (path) {
          if (!path) { setStatusText('已取消'); return; }
          setStatusText('创建会话中: ' + path);
          return workspaces.create({ path: path }).then(function (ws) {
            // create 返回 WorkspaceView：id 字段名是 workspaceId（wire 契约，
            // 曾误用 ws.id → connectWorkspace(undefined) → unknown workspace）
            return uiWorkspace.connectWorkspace(ws.workspaceId);
          }).then(function (sessionId) {
            // 0.2.1 里"设为当前会话"只有平台导航这一条路（sessions.open 已不存在，调用会抛错
            // 并打断后面的状态提示与 root 切换）
            if (sessionId) { try { uiWorkspace.openSession(sessionId); } catch (e) { /* 平台导航失败不影响 IDE */ } }
            setStatusText('工作空间已就绪');
            trace('ui', 'info', 'open-folder', { path: path, sessionId: sessionId || null });
            // root 立刻认下来（写记忆 + 上报 + 换树）—— 不再等 800ms 后的会话 cwd 回填
            adoptRoot(path);
            setTabs([]);
            setActivePath(null);
            setRefreshTick(function (t) { return t + 1; });
            refreshOverview();
            // 等平台导航完成 current 切换后再刷新一次（root 上报与快照/会话状态对齐）
            setTimeout(function () { refreshOverview(); }, 800);
          });
        }).catch(function (e) {
          var msg = String((e && e.message) || e);
          setStatusText('打开文件夹失败: ' + msg);
          trace('ui', 'error', 'open-folder-failed', { error: msg });
        });
      }

      function pluginAction(action, pluginId) {
        setBusy(true);
        trace('ui', 'info', 'plugin-action', { action: action, pluginId: pluginId });
        apiPost('/plugin-' + action, { pluginId: pluginId }).then(function (r) {
          setBusy(false);
          setStatusText((r && r.ok) || (r && r.reason) || (r && r.message) || action + ' ' + pluginId);
          refreshOverview();
        }).catch(function () { setBusy(false); });
      }

      return h('div', { className: 'dside-root' },
        h('div', { className: 'dside-titlebar' + (upd && upd.installed ? ' has-overlay' : '') },
          // 品牌标记：**路径左边一个小 logo**（2026-09-20 用户要回来；2026-09-17 曾按用户要求
          // 删掉过，当时的理由是"别和系统窗口标题栏重复"——现在用户要它在工作空间路径左边）。
          // 图是 64px 瓷片（assets\logo64.png）的 data URI 内嵌（LOGO_DATA_URI），
          // 所以不为一张小图加静态路由；换 logo 的流程见 00devCore §3「换 logo 流程」。
          h('img', { className: 'dside-titlebar-logo', src: LOGO_DATA_URI, alt: '', title: '天工', draggable: false }),
          h('span', { className: 'dside-titlebar-path', title: root || '' },
            root || '未选择工作空间'),
          // 标题栏右侧**只留版本徽标**：打开文件夹 / 刷新 / 终端三个按钮已按用户要求移走
          // （2026-09-20）——「打开文件夹」进左侧「操作」组的「文件」区块，刷新与终端删掉
          // （终端仍可 Ctrl+` / 命令面板 / 操作组打开，功能不砍，只是不占标题栏）。
          // 版本徽标 + 更新入口（只有 AnzioAgent 壳里才有桥；浏览器里不显示）
          upd && upd.installed
            ? (upd.phase === 'available'
                ? h('button', {
                    className: 'dside-upd has',
                    title: '新版本 v' + ((upd.latest && upd.latest.version) || '') + ' 可用 — 点击下载安装'
                      + ((upd.latest && upd.latest.notes) ? '\n\n' + upd.latest.notes : ''),
                    onClick: installUpdate,
                  }, '⬆ 新版本 v' + ((upd.latest && upd.latest.version) || ''))
                : (upd.phase === 'downloading'
                    ? h('span', { className: 'dside-upd' }, '下载更新中 ' + Math.round((upd.progress || 0) * 100) + '%')
                    : (upd.phase === 'ready'
                        ? h('button', { className: 'dside-upd has', onClick: applyUpdate }, '⟳ 重启并安装 v' + ((upd.latest && upd.latest.version) || ''))
                        : h('button', {
                            className: 'dside-upd',
                            title: (upd.phase === 'error' ? '更新源读取失败：' + (upd.error || '') : '当前版本 — 点击检查更新')
                              + '\n（快捷键 Ctrl+Shift+U）',
                            onClick: checkUpdate,
                          }, 'v' + upd.installed + (upd.phase === 'error' ? ' ⚠' : '')))))
            : null,
        ),
        h('div', { className: 'dside-main' },
          // 左侧活动栏（VSCode 手感：图标竖排，点谁切谁，再点收起）
          h(ActivityBar, { active: activity, panelOpen: showExplorer, onPick: pickActivity }),
          showExplorer
            ? h('div', { className: 'dside-leftpanel', style: { width: layout.sideW + 'px' } },
                (activity === 'explorer'
                ? h(Explorer, {
                    root: root,
                    // 选中态 = 当前聚焦的树节点（没点过树就跟随活动标签）—— 文件夹也能被选中
                    selected: treeSel ? treeSel.path : activePath,
                    refreshTick: refreshTick, fsRev: fsRev, onContext: treeContext,
                    // ⑮ VSCode 手感：单击 = 预览标签（斜体、复用同一个），双击 = 固定打开
                    onSelect: function (f) { openTab(f, 'preview'); },
                    onOpen: function (f) { openTab(f); },
                    // ⑲ 标题栏四个动作 + 内联新建（目标层级 = 当前聚焦节点）
                    onFocusNode: setTreeSel,
                    inlineNew: inlineNew,
                    onInlineSubmit: submitInlineNew,
                    onInlineCancel: cancelInlineNew,
                    collapseTick: collapseTick,
                    onNewFile: function () { startNewEntry('file', treeSel); },
                    onNewFolder: function () { startNewEntry('dir', treeSel); },
                    onCollapseAll: function () { setCollapseTick(function (n) { return n + 1; }); trace('ui', 'info', 'tree-collapse-all', {}); },
                    onRefresh: function () { setRefreshTick(function (t) { return t + 1; }); refreshOverview(); trace('ui', 'info', 'tree-refresh', {}); },
                  })
                : (activity === 'actions'
                    ? h(BlocksPanel, { title: '操作', blocks: actionBlocks() })
                    : (activity === 'plugins'
                        // ⑯ 插件面板（原右侧面板那个标签页，2026-09-21 用户要求搬到左侧活动栏）
                        ? h('div', { className: 'dside-explorer' },
                            h('div', { className: 'dside-pane-title' }, '插件'),
                            h(PluginPanel, { plugins: plugins, busy: busy, onAction: pluginAction }))
                        : h(BlocksPanel, { title: '设置', blocks: settingsBlocks() })))),
                // ⑰ 左栏手柄：挂在面板内部、绝对定位压在右边缘（不占布局空间，VSCode 同款）
                h(Sash, {
                  dir: 'col', edge: 'right',
                  onDrag: function (d) { nudgeLayout('sideW', d); },
                  onReset: function () { resetLayout('sideW'); },
                }))
            : null,
          h('div', { className: 'dside-centercol' },
            // 中面板 = 编辑器 + （可选）快捷键设置页。**编辑器不卸载**：monaco 实例/未保存缓冲区都在
            // 它身上，卸载等于丢用户没保存的编辑 —— 所以这里只是绝对定位藏起来（见 .dside-center-editor.hidden）。
            h('div', { className: 'dside-center-body', onDragEnter: onEditorDragEnter, onDragOver: onEditorDragOver, onDrop: onEditorDrop },
              h('div', { className: 'dside-center-editor' + (centerView !== 'editor' ? ' hidden' : '') },
                h(Editor, {
                  // 伪路径标签（差异/设置）的正文要平台内容 → 外壳的 renderSlot 下传（授权跟着注册条目走）
                  renderSlot: props.renderSlot,
                  // 设置标签里的快捷键页改绑之后，编辑器要重新应用键位
                  onKeysChanged: function () { setKeysRev(function (n) { return n + 1; }); },
                  file: activeFile, tabs: tabs, activePath: activePath,
                  onActivate: function (p) { activatePath(p, 'click'); }, onCloseTab: closeTab, onDirtyChange: onDirtyChange,
                  onPromote: promoteTab, onTabContext: tabContext, onTogglePin: togglePinTab,
                  onToggleMdPreview: toggleMdPreview,   // Markdown 预览开关（编辑器标题栏那颗按钮 / Ctrl+Shift+V）
                  pinnedCompact: !!tabPrefs.pinnedCompact,
                  editorBridge: editorBridgeRef,
                  draftGetterRef: draftGetterRef,   // 会话恢复：落盘时取脏缓冲区正文
                  refreshTick: refreshTick, status: setStatusText, themeMode: themeMode,
                  gotoReq: gotoReq, root: root, onAskAgent: onAskAgent, onRequestGoto: jumpToPath,
                  onMoveTab: moveTab,
                  onMissingFile: onMissingFile,   // 会话恢复兜底：恢复出来的文件其实读不到了
                  onBrowserTitle: onBrowserTitle, // 内置浏览器：网页标题 → 标签名
                  reviewReq: reviewReq, onRollbackChange: rollbackByPath,
                  // ⑥ 第四刀：逐块保留/撤销。浮层只能用回调 —— 块状态表在本组件里，它那边够不着
                  // （见外层 hunksWithStatus 的告警；2026-10-10 就是这里缺回调、浮层直接读崩白屏）
                  onHunkKeep: function (ck, hk) { markHunk(ck, hk, 'kept'); },
                  onHunkUndo: function (ck, hk) { rollbackHunk(ck, hk); },
                  // 差异标签工具栏那颗「保留这个文件」：ReviewPane 只认 changeKey，这里换回组
                  onKeepFile: function (rkey) { var gg = groupByChangeKey(rkey); if (gg) keepGroups([gg], gg.name); },
                  onSnapshotRestore: restoreSnapshot,
                  keysRev: keysRev,
                })),
              // （快捷键页 / 编辑器设置页 2026-10-12 起是中栏标签 settings://keys|editor-prefs，
              //   由 Editor 里的 settingsEl 渲染 —— 不再走 centerView 这套"盖一层、关不掉"的视图）
              // （设置已改成中栏标签 settings://，见 Editor 里的 settingsEl；不再走 centerView 视图）
            ),
            // ⑯ 集成终端**只在中间这一列里**（用户 2026-09-21 明确要求："不要跑去 chat 面板，只能在中间面板"）
            // ⑰ 它的高度手柄在 TermPanel 内部（压在面板上边缘，只跨中间列）
            termOpen
              ? h(TermPanel, {
                  // ③ B 方案（用户 2026-09-22 拍板）：单终端 —— 换目录就换 key，组件重挂载即用新 cwd
                  //    起新 PTY，旧 PTY 在它的 cleanup 里被 /term-close 关掉。
                  //    ⚠ key 里**不能带 root**：active-root 会跟着会话 cwd 反复覆盖回会话根，
                  //      带上 root 就会在用户干活时把终端反复重建（把正在跑的 shell 杀掉）。
                  //    termRev = 「新建终端」显式递增的重建计数（见 termRevState）。
                  key: (termCwd || 'term') + '#' + termRev,
                  root: termCwd || root, themeMode: themeMode,
                  height: layout.termH,
                  onResize: function (d) { nudgeLayout('termH', -d); },
                  onResizeReset: function () { resetLayout('termH'); },
                  onClose: function () { setTermOpen(false); },
                  // 第三期：面板内的第二个标签（Agent 键盘映射）
                  pane: termPane,
                  onPane: kbSwitchPane,
                  kb: kb,
                  kbFlash: kb.flash,
                })
              : null,
          ),
          h('div', { className: 'dside-side', style: { width: layout.rightW + 'px' } },
            // ⑰ 右栏手柄：同样挂在面板内部、压在左边缘
            h(Sash, {
              dir: 'col', edge: 'left',
              onDrag: function (d) { nudgeLayout('rightW', -d); },
              onReset: function () { resetLayout('rightW'); },
            }),
            // 2026-09-21 用户要求：右侧永远固定是 Agent 面板（去掉顶部「Agent 助手 / 插件」标签栏），
            // 「插件」搬到左侧活动栏做一个分组
            // 操作栏：新对话（在当前工作空间里再开一个会话）
            h('div', { className: 'dside-side-actions' },
              h('button', {
                className: 'dside-btn primary small',
                title: root ? ('在「' + root + '」里开一个新对话') : '还没有工作空间 —— 先选一个文件夹',
                onClick: newChat,
              }, '＋ 新对话'),
              h('button', {
                className: 'dside-btn small' + (sessionsOpen ? ' primary' : ''),
                title: '展开 / 收起历史对话（可在全部对话内容里搜索）',
                onClick: function () { setSessionsOpen(function (v) { return !v; }); },
              }, '🕘 历史对话'),
            ),
            h(AgentPanel, {
                  listState: listState, current: current, conv: conv, sessionFace: sessionFace,
                  sessionsOpen: sessionsOpen, sesSearch: sesSearch,
                  onSessionSearch: onSessionSearch,
                  onToggleSessions: function () { setSessionsOpen(function (v) { return !v; }); },
                  rounds: roundList, pendingGroups: pendingGroups, allGroups: allGroups,
                  historyOpen: historyOpen, hasMoreChanges: !!(conv && conv.hasMore),
                  onToggleHistory: function () {
                    setHistoryOpen(!historyOpen);
                    trace('ui', 'info', 'change-history-toggle', { open: !historyOpen, rounds: roundList.length });
                  },
                  onReviewGroups: reviewGroups, onRollbackChange: rollbackChange,
                  onKeepGroups: keepGroups, onUndoGroups: undoGroups,
                  onKeepAll: keepAllChanges, onUndoAll: undoAllChanges,
                  onSelectSession: function (id) {
                    setDraftSession(null);   // 用户手动选会话 → 放弃"刚建的空对话"这个当前会话
                    // 切会话**只能走平台导航**：uiWorkspace.openSession(id) 会把它 retain 成主视图，
                    // uiSession.adapter.current 随后推给右栏。
                    // ⚠ 旧写法 sessions.open(id) 在 0.2.1 已不存在，调用直接抛错 —— 表现就是
                    //   "点历史会话毫无反应"（高亮不变、右栏不动，2026-10-13 实测）。
                    uiWorkspace.openSession(id);
                    // 切到其他会话时工作空间跟着切（root 跟随会话 cwd）
                    setTimeout(function () { refreshOverview(); }, 800);
                  },
                  onSend: sendMessage, onCancel: cancelTurn, onNewSession: newChat,
                  renderSlot: props.renderSlot,   // 平台会话槽（root children 的 main）
                }),
          ),                                   // 关闭 .dside-side
        ),
        h('div', { className: 'dside-statusbar' },
          h('span', null, statusText),
          // ⑤ 诊断计数（点开问题面板）；没有错误/警告时不占位
          (probCounts.e || probCounts.w)
            ? h('span', {
                className: 'dside-prob' + (probCounts.e ? ' err' : ''),
                title: '点击打开问题面板（Ctrl+Shift+M）',
                onClick: function () {
                  prevFocusRef.current = document.activeElement;
                  setSearchOpen(false);
                  setOverlay(function (prev) { return prev === 'problems' ? null : 'problems'; });
                },
              }, (probCounts.e ? '✕ ' + probCounts.e : '') + (probCounts.e && probCounts.w ? '   ' : '') + (probCounts.w ? '⚠ ' + probCounts.w : ''))
            : null,
          // ⑯ 终端入口（2026-09-21 用户报障"按钮被藏了、快捷键又不行"）：状态栏常驻一个可见开关，
          // 与 VSCode 把面板开关放在状态栏同款；Ctrl+` / 操作组 / 命令面板三条入口照旧都在
          h('span', {
            className: 'dside-snapstat' + (termOpen ? ' on' : ''),
            title: '集成终端（Ctrl+` / Ctrl+J）：点一下打开 / 收起'
              + (kb.flash && !termOpen ? '（Agent 正在操作浏览器，键盘映射面板里有新按键）' : ''),
            onClick: function () { setTermOpen(function (v) { return !v; }); },
          }, '⌨ 终端',
            // 面板关着的时候没有标签可闪 → 在状态栏这颗开关上闪，别把 Agent 的动作变成"什么都没发生"
            (kb.flash && !termOpen) ? h('span', { className: 'dside-dot dirty' }) : null),
          h('span', {
            className: 'dside-snapstat',
            title: '工作区快照（回撤 / 还原）：Agent 每轮开始前、每次保存后自动存一份；点开可看差异并一键还原',
            onClick: openSnapshots,
          }, snapLast ? ('⏱ 快照 ' + snapTimeText(snapLast)) : '⏱ 快照'),
          h('span', { className: 'sp' }, 'UTF-8 · 文本'),
          h('span', { className: 'sp' }, '天工 · DSH 引擎'),
        ),
        // ── ③ overlay：命令面板 / 快速打开 / 全局搜索（互斥，置顶渲染）──
        overlay === 'commands'
          ? h(PaletteOverlay, {
              title: '命令面板', placeholder: '输入命令名…（F1 / Ctrl+Shift+P）',
              fetchItems: fetchCommands, score: commandScore,
              describe: function (cmd) { return { icon: cmd.icon, title: cmd.title, detail: cmd.cat }; },
              onPick: runCommand, onClose: closeOverlays,
            })
          : null,
        overlay === 'files'
          ? h(PaletteOverlay, {
              title: '打开文件', placeholder: '输入文件名过滤…（Ctrl+P）',
              fetchItems: fetchFiles, score: fileScore,
              describe: function (f) { return { icon: iconFor({ type: 'file', name: f.name }), title: f.name, detail: f._rel }; },
              onPick: function (f) { closeOverlays(); openTab({ name: f.name, path: f.path }, (tabPrefs.preview && tabPrefs.fromQuickOpen) ? 'preview' : null); },
              onClose: closeOverlays,
            })
          : null,
        searchOpen
          ? h(SearchOverlay, { root: root, onJump: jumpFromSearch, onClose: closeOverlays, onStatus: setStatusText })
          : null,
        overlay === 'snapshots'
          ? h(SnapshotPanel, {
              onClose: closeOverlays, onStatus: setStatusText,
              onReview: reviewSnapshot, onRestore: restoreSnapshot,
            })
          : null,
        overlay === 'problems'
          ? h(ProblemsOverlay, {
              root: root, onJump: jumpFromProblems, onClose: closeOverlays,
              // ⑤ 项目级全量诊断：交给 Editor（它握着 worker 与项目文件清单）
              onScan: function () {
                var b = editorBridgeRef.current;
                if (b && b.scanProjectProblems) return b.scanProjectProblems();
                return Promise.resolve({ rows: [], files: 0 });
              },
            })
          : null,
        // ⑫ 右键菜单（点空白/Esc 关闭；菜单项由节点类型决定）
        treeMenu
          ? h('div', null,
              h('div', {
                className: 'dside-menu-backdrop',
                onClick: closeTreeMenu,
                onContextMenu: function (e) { e.preventDefault(); closeTreeMenu(); },
              }),
              h(TreeMenu, { x: treeMenu.x, y: treeMenu.y, items: treeMenuItems(), onClose: closeTreeMenu }),
            )
          : null,
        // ⑮ 标签右键菜单（与文件树菜单同一套组件 / 背板）
        tabMenu
          ? h('div', null,
              h('div', {
                className: 'dside-menu-backdrop',
                onClick: closeTabMenu,
                onContextMenu: function (e) { e.preventDefault(); closeTabMenu(); },
              }),
              h(TreeMenu, { x: tabMenu.x, y: tabMenu.y, items: tabMenuItems(), onClose: closeTabMenu }),
            )
          : null,
        nameDialog
          ? h(NameDialog, {
              title: nameDialog.title, initial: nameDialog.initial,
              placeholder: nameDialog.placeholder, hint: nameDialog.hint,
              onSubmit: nameDialog.onSubmit,
              onCancel: function () { setNameDialog(null); },
            })
          : null,
        // 对话回退 · 第二段确认（口径）：只在"这一退真会动到文件"时出现。
        // 挂在这里（最外层）而不是挂在对话行里：行里的浮层会被对话容器的滚动/变换裁掉。
        rewindDialog
          ? h(RewindConfirmDialog, {
              count: rewindDialog.count, files: rewindDialog.files,
              onConfirm: rewindDialog.onConfirm, onCancel: rewindDialog.onCancel,
            })
          : null,
        // 平台的 frame-wide 浮层（弹窗 / 提示 / toast）——声明了 shell.overlay 就得给它一块地，
        // 否则平台那些对话框无处渲染（以前我们把 root 整个换掉 = 它们全都消失）。
        props.renderSlot
          ? h('div', { className: 'dside-overlay-layer', 'data-shell-overlay': '' }, props.renderSlot('shell.overlay', {}))
          : null,
      );
    }

    // ── 对话回退：待回退状态（**只在内存里**，关软件自然丢 = 口径里的"关软件默认取消"）────
    // 结构照 VSCode 那套（本地源码 1.138 亲读 chatEditing*）：回退只动一个"游标"，对话数据一个字不改；
    // "回退点之后看不见"是一层**视图过滤**；真正永久砍掉发生在**发出新消息那一刻**。
    // 界面这半只有两条规则：
    //   ① 待回退期间：轮次排在回退点之后的对话行藏起来（日志没改过，撤掉隐藏就恢复）
    //   ② 会话里一冒出新东西（用户发出了新消息），后端此刻已在"发请求之前"把分隔条落下 ⇒ 收摊：
    //      解除隐藏、撤掉「已恢复到检查点」
    // ⚠ 判据只有一个（轮次）、信号只有一个（会话事件流）。上一版在这里堆了"名单 / 收手 / 回头问
    //   后端"三层，两次翻车都出在那套接缝上 —— 别再加回去。
    var rewindPending = null
    var rewindListeners = []
    var rewindHidden = []
    var rewindObserver = null
    // 事件窗口里见过的最大序号（没在待回退状态时一直跟着更新）：它就是"进入待回退那一刻"的基线，
    // 之后只要冒出更大的序号，就说明会话有新内容了（用户发了消息）。
    var rewindSeenSeq = 0
    // 定局失败的原因（后端给的）：挂在「已恢复到检查点」那条上显示，绝不静默
    var rewindFailNote = ''
    function rewindNotify() {
      for (var i = 0; i < rewindListeners.length; i++) { try { rewindListeners[i]() } catch (e) { /* 忽略 */ } }
    }
    function rewindSubscribe(fn) {
      rewindListeners.push(fn)
      return function () { rewindListeners = rewindListeners.filter(function (f) { return f !== fn }) }
    }
    // 藏行的判据只有一条：这一行的轮次排在回退点之后。
    // ⚠ 用户新发的那条消息也满足它，所以"收摊"必须够快 —— 靠下面的会话事件流（真信号），
    //   不靠任何 DOM 猜测。
    function rewindShouldHide(el) {
      if (rewindPending === null) return false
      return Number(el.getAttribute('data-chat-turn')) > rewindPending.turn
    }
    function rewindHideRows() {
      var out = []
      var rows = document.querySelectorAll('[data-chat-node-key][data-chat-turn]')
      for (var i = 0; i < rows.length; i++) {
        if (rewindShouldHide(rows[i]) && rows[i].style.display !== 'none') {
          rows[i].style.display = 'none'
          out.push(rows[i])
        }
      }
      return out
    }
    function rewindReleaseHidden() {
      for (var i = 0; i < rewindHidden.length; i++) { try { rewindHidden[i].style.display = '' } catch (e) { /* 节点没了 */ } }
      rewindHidden = []
    }
    function rewindStopObserver() {
      if (rewindObserver !== null) { try { rewindObserver.disconnect() } catch (e) { /* 忽略 */ } rewindObserver = null }
    }
    function rewindMaxSeq(entries) {
      var max = 0
      for (var i = 0; i < entries.length; i++) {
        var ev = entries[i] && entries[i].event
        if (ev && Number(ev.seq) > max) max = Number(ev.seq)
      }
      return max
    }
    /** 会话事件窗口每更新一次就过一眼。这是"收摊"的**唯一信号**：
     *  · 没在待回退状态时：把窗口最大序号记成基线（进入待回退那一刻的基线就是它）；
     *  · 在待回退状态时：冒出"比基线更晚的真实用户消息"或"我们自己的分隔条" = 用户已经发出去了。
     *    后端在那一刻（消息进待办队列、还没落进会话、更没组装请求）就把分隔条落下了，
     *    所以界面这时收摊：解除隐藏、撤掉「已恢复到检查点」。
     *  顺手问一次后端拿失败原因（就这一次，不是轮询）。 */
    function rewindWatchWindow(win, sessionId) {
      var entries = (win && win.entries) || []
      if (rewindPending === null) {
        rewindSeenSeq = rewindMaxSeq(entries)
        return
      }
      if (String(rewindPending.sessionId) !== String(sessionId || '')) return
      var hit = false
      for (var i = 0; i < entries.length; i++) {
        var ev = entries[i] && entries[i].event
        if (!ev || String(ev.type) !== 'user/message') continue
        if (Number(ev.seq) <= Number(rewindSeenSeq)) continue
        var kind = String(((ev.data && ev.data.source) || {}).kind || '')
        // 只认这两类：真实用户消息（用户发出了新消息）· 我们自己的分隔条（定局落下）。
        // 别的系统注入（runtime-context / system-reminder 之类）不算数。
        if (kind === 'user' || kind === 'dsh-ide-rewind') { hit = true; break }
      }
      if (!hit) return
      var sid = String(rewindPending.sessionId)
      rewindFailNote = ''
      setRewindPending(null)
      setStatusText('已从检查点重新开始：后面那段已经永久丢弃')
      trace('ui', 'info', 'rewind-auto-committed', { sessionId: sid })
      apiGet('/rewind-state', { sessionId: sid }).then(function (r) {
        var note = String((r && r.note) || '')
        if (note === '') return
        rewindFailNote = note
        setStatusText('回退没能定局：' + note)
        trace('ui', 'error', 'rewind-auto-commit-failed', { error: note, sessionId: sid })
        rewindNotify()
      })
    }
    // 虚拟滚动会反复重造行 ⇒ 待回退期间挂个观察者一直藏；取消/定局后把藏过的放出来
    function rewindApplyHide() {
      if (rewindPending === null) {
        rewindReleaseHidden()
        rewindStopObserver()
        return
      }
      var els = rewindHideRows()
      for (var j = 0; j < els.length; j++) rewindHidden.push(els[j])
      if (rewindObserver === null) {
        try {
          rewindObserver = new MutationObserver(function () {
            if (rewindPending === null) return
            var more = rewindHideRows()
            for (var k = 0; k < more.length; k++) rewindHidden.push(more[k])
          })
          rewindObserver.observe(document.body, { childList: true, subtree: true })
        } catch (e) { /* 观察失败只是可能露出来，不致命 */ }
      }
    }
    function setRewindPending(next) {
      rewindPending = next
      if (next !== null) rewindFailNote = ''   // 新的一次回退：上一轮的失败提示不带到这一轮
      rewindApplyHide()
      rewindNotify()
    }
    // 定局：编辑器里「问 Agent」那条路发消息时由前端叫一声。
    // ⚠ 用户平时打字的输入框是平台原生的，根本不经过这里 —— 那条路由后端监听会话事件自动定局
    //   （见 host 半的注释）。两条路都落到同一个后端接口，谁先到谁算，重复的会被串行闸挡掉。
    function rewindCommitIfPending() {
      var p = rewindPending
      if (p === null) return
      apiPost('/rewind-commit', { sessionId: String(p.sessionId), afterSeq: p.afterSeq })
        .then(function (r) {
          if (r && r.ok === true) { rewindFailNote = ''; setRewindPending(null); return }
          if (r && r.code === 'nothing-after-checkpoint') { setRewindPending(null); return }
          // 失败：账和后端都还留着，把原因摆到用户眼前（以前这里只写一行日志，用户什么都看不到）
          rewindFailNote = String((r && (r.error || r.code)) || '未知')
          setStatusText('回退没能定局：' + rewindFailNote)
          trace('ui', 'error', 'rewind-commit-failed', { error: rewindFailNote })
          rewindNotify()
        })
        .catch(function () {
          rewindFailNote = '网络'
          setStatusText('回退没能定局：网络')
          trace('ui', 'error', 'rewind-commit-failed', { error: 'network' })
          rewindNotify()
        })
    }

    // ── 对话回退 · 第二段确认（口径）：这一退**真会动到文件**时才拦一下 ──────────────
    // 弹窗状态也放模块级、由**外壳**渲染：行里的浮层会被对话容器的滚动/变换裁掉，别图省事。
    // 「不要再问」记在本机 localStorage（与字号/布局那套同一个地方）：按人记一次，之后直接退。
    var REWIND_ASK_KEY = 'dside.rewindAskSkip.v1'
    function rewindAskSkipped() {
      try { return window.localStorage.getItem(REWIND_ASK_KEY) === 'yes' } catch (e) { return false }
    }
    function setRewindAskSkip() {
      try { window.localStorage.setItem(REWIND_ASK_KEY, 'yes') } catch (e) { /* 拿不到存储：退化成每次都问，功能不崩 */ }
    }
    var rewindDialog = null
    function setRewindDialog(next) {
      rewindDialog = next
      for (var i = 0; i < rewindListeners.length; i++) { try { rewindListeners[i]() } catch (e) { /* 忽略 */ } }
    }
    /** 真退（横线上的按钮与弹窗里的「是」都走这一个入口，免得两处逻辑走偏）。 */
    function rewindRunApply(sessionId, afterSeq, turn) {
      setRewindDialog(null)
      return apiPost('/rewind-apply', { sessionId: String(sessionId), afterSeq: Number(afterSeq) })
        .then(function (r) {
          if (r && r.ok === true) {
            setRewindPending({ sessionId: String(sessionId), afterSeq: Number(afterSeq), turn: turn })
            return { ok: true, prompt: typeof r.prompt === 'string' ? r.prompt : '' }
          }
          return {
            ok: false,
            note: r && r.code === 'nothing-after-checkpoint'
              ? '这里后面已经没有内容了'
              : ('没退成：' + String((r && (r.error || r.code)) || '未知')),
          }
        })
        .catch(function () { return { ok: false, note: '没退成：网络' } })
    }

    // 第二段确认弹窗（模块级定义；由外壳渲染）
    function RewindConfirmDialog(props) {
      var files = Array.isArray(props.files) ? props.files : [];
      React.useEffect(function () {
        function onKey(e) { if (e.key === 'Escape') props.onCancel() }
        window.addEventListener('keydown', onKey, false)
        return function () { window.removeEventListener('keydown', onKey, false) }
      }, []);
      return h('div', { className: 'dside-overlay', onClick: props.onCancel },
        h('div', { className: 'card dside-dialog', onClick: function (e) { e.stopPropagation() } },
          h('div', { className: 'dside-palette-head' },
            h('span', { className: 'dside-palette-title' }, '要撤销最后一次编辑吗？'),
          ),
          h('div', { className: 'dside-dialog-body' },
            h('div', { className: 'dside-dialog-text' }, '回退会把 Agent 改过的文件一并摆回去，这次会动 ' + files.length + ' 个文件：'),
            h('div', { className: 'dside-dialog-list' },
              files.slice(0, 6).map(function (f) {
                return h('div', { className: 'dside-dialog-file', key: String(f.path) }, String(f.path))
              }).concat(files.length > 6
                ? [h('div', { className: 'dside-dialog-file', key: '__more' }, '…还有 ' + (files.length - 6) + ' 个')]
                : []),
            ),
            h('div', { className: 'dside-dialog-row' },
              h('button', { className: 'dside-btn', onClick: props.onCancel }, '取消'),
              h('button', { className: 'dside-btn', onClick: function () { props.onConfirm(true) } }, '不要再问'),
              h('button', { className: 'dside-btn danger', onClick: function () { props.onConfirm(false) } }, '是'),
            ),
          ),
        ),
      );
    }

    // ── 对话回退：每轮回复末尾的"横线 + 回退按钮"（挂官方对话的轮尾插槽）──────────
    // 为什么挂插槽而不改官方源码：官方在"一轮回复收尾"处留了 conversation.chat.turnTail
    // 这个列表槽，并且会把**这一轮的收尾位置（seq）**随 props 递进来 —— 那正是我们要的检查点。
    // 两段确认（口径）：第一下只是"上膛"（按钮变「丢弃改动」+ ✕，可反悔），第二下才真退。
    // ⚠ 第一轮回复末尾**也要挂**（2026-10-14 用户钉死："第一轮消息也可能改代码"）。
    // 旧口径把它砍了、理由是"退到第一条回复之前没意义" —— 那是把两个位置搞混了：
    // 我们这条横线挂"第 N 轮回复末尾"，而"第 1 轮末尾"= VSCode 第 2 条消息上方那个**普通检查点**
    // （VSCode 源码：MenuId.ChatMessageCheckpoint 挂在每条用户消息上方；第一条上方那个才特殊，
    // 是 Start Over「清空对话并撤销全部改动」）。退回第 1 轮末尾 = 撤掉第 2 轮及以后。
    // ⚠ 组件必须在模块级定义：写进别的组件里，父组件每重渲染都会生成新类型，React 会把整块重挂。
    function RewindTailEntry(props) {
      var tickState = React.useState(0);
      var setTick = tickState[1];
      var armedState = React.useState(false);
      var armed = armedState[0], setArmed = armedState[1];
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      var noteState = React.useState('');
      var note = noteState[0], setNote = noteState[1];
      // 待回退状态是模块级的：订阅它，别的检查点上退过之后这一格也要跟着变
      React.useEffect(function () {
        return rewindSubscribe(function () { setTick(function (v) { return v + 1 }) })
      }, []);
      var turn = props.turn && typeof props.turn.turn === 'number' ? props.turn.turn : 0;
      // 回填输入框（口径："你当时那句话回填输入框"）。走 session 作用域槽的标准属性 inputActions
      // （ui-conversation 把它并进 SessionStandardProps，官方自己的语音输入插件就这么往里写字）；
      // ⚠ 别去改 DOM：那是 contenteditable + Lexical 受控，直接改不会同步平台状态。
      // ⚠ useInput 只能在渲染期调，所以趁渲染把当前草稿读出来，别在回调里现调。
      var hasInput = props.inputActions !== undefined && typeof props.useInput === 'function';
      var draftNow = hasInput
        ? props.useInput(function (s) { return s && typeof s.draft === 'string' ? s.draft : '' })
        : '';
      function refill(text) {
        var ia = props.inputActions;
        if (!ia || typeof ia.setDraft !== 'function') return false;
        if (String(draftNow || '').trim() !== '') return false;   // 输入框里已经有半截话：一个字不动
        ia.setDraft(text);
        return true;
      }
      var sid = String(props.sessionId || '');
      var pendingHere = rewindPending !== null
        && String(rewindPending.sessionId) === sid && rewindPending.turn === turn;
      function run() {
        rewindRunApply(sid, Number(props.seq), turn).then(function (out) {
          setBusy(false);
          setArmed(false);
          if (out && out.ok !== true) { setNote(out.note || '没退成'); return; }
          if (out && typeof out.prompt === 'string' && out.prompt !== '') refill(out.prompt);
        });
      }
      function go() {
        if (busy) return;
        setBusy(true);
        setNote('');
        // 先问一句"这次会动到哪些文件"（口径·第二段确认）：真要把文件摆回去才拦一下；
        // 没动到文件就直接退。问不到（网络/异常）时也不拦 —— 上面那道"上膛"本身就是确认。
        apiPost('/rewind-preview', { sessionId: sid, afterSeq: Number(props.seq) })
          .then(function (r) {
            if (r && r.ok === true && Number(r.count) > 0 && !rewindAskSkipped()) {
              setBusy(false);
              setRewindDialog({
                count: Number(r.count),
                files: Array.isArray(r.files) ? r.files : [],
                onConfirm: function (skip) { if (skip) setRewindAskSkip(); run(); },
                onCancel: function () { setRewindDialog(null); setArmed(false); },
              });
              return;
            }
            run();
          })
          .catch(function () { run(); });
      }
      function cancel() {
        if (busy) return;
        setBusy(true);
        apiPost('/rewind-cancel', { sessionId: sid, afterSeq: Number(props.seq) })
          .then(function (r) {
            setBusy(false);
            setRewindPending(null);
            if (!r || r.ok !== true) { setNote('撤销没成：' + String((r && r.error) || '未知')); return; }
            rewindFailNote = '';   // 自己取消了 ⇒ 上一轮的定局失败提示一并撤掉
          })
          .catch(function () { setBusy(false); setRewindPending(null); setNote('撤销没成：网络'); });
      }
      if (pendingHere) {
        return h('div', { className: 'dside-rewind done', 'data-rewind-turn': String(turn), 'data-rewind-seq': String(props.seq) },
          h('div', { className: 'dside-rewind-line' }),
          h('span', { className: 'dside-rewind-done' }, '已恢复到检查点'),
          h('button', {
            className: 'dside-rewind-btn show', type: 'button', disabled: busy,
            title: '把文件和对话都还原到刚才的样子',
            onClick: cancel,
          }, busy ? '正在撤销…' : '取消这次回退'),
          // 后端定局失败的原因也挂在这一条上（以前只写日志，界面上什么都看不到）
          (note || rewindFailNote) ? h('span', { className: 'dside-rewind-note' }, note || rewindFailNote) : null,
        );
      }
      return h('div', { className: 'dside-rewind' + (armed ? ' armed' : ''), 'data-rewind-turn': String(turn), 'data-rewind-seq': String(props.seq) },
        h('div', { className: 'dside-rewind-line' }),
        h('button', {
          className: 'dside-rewind-btn' + (armed ? ' armed' : ''),
          type: 'button',
          disabled: busy,
          title: armed ? '再点一次就真的退回去（此后的对话会从界面上消失）' : '回退到这条回复结束的位置',
          onClick: function () { if (armed) go(); else { setArmed(true); setNote(''); } },
        }, busy ? '正在退回…' : (armed ? '丢弃改动' : '回退到这里')),
        armed
          ? h('button', {
            className: 'dside-rewind-x',
            type: 'button',
            title: '算了，不退',
            onClick: function () { setArmed(false); setNote(''); },
          }, '✕')
          : null,
        note ? h('span', { className: 'dside-rewind-note' }, note) : null,
      );
    }

    function apply(ctx) {
      // ── 对话框版式声明（2026-09-22 用户要求）────────────────────────────
      // ① 左上那个「工作区切换」没什么用 ⇒ 去掉；
      // ② 「创造模式」（Agent 预设）搬到输入框那行的「完全权限」右边 —— 也就是让平台把
      //    它渲染进 composer 的工具行，而不是 hero 上方那一行。
      // 平台侧读 `globalThis.__DSH_HOST_COMPOSER__`（ui-conversation 的 host-layout.ts）：
      // 只有"替换了 frame root 的宿主"才会声明它，开发台（平台自己的 ui-layout）不受影响。
      try { window.__DSH_HOST_COMPOSER__ = { presetInToolRow: true }; } catch (e) { /* 声明失败只是版式退回平台默认 */ }
      var workspaces = ctx.get('workspaces');
      var sessions = ctx.get('sessions');

      // ── @ 引用的「打开的文件」候选源（2026-10-19 用户要求）──────────────────
      // 官方那个 @ 来源在裸 @ 时列的是工作区根目录（文件夹优先 + 名字字典序），
      // 第一个永远是 $RECYCLE.BIN 这类目录；用户要的是"先看到当前编辑器开着的文件"。
      // 菜单是"一个来源一组、按 order 排"（ui-input-trigger 的 roster），所以这里注册一个
      // order 更前的来源：只在还没输入过滤词时给最多 3 行；输入过滤词后整组消失，交给官方文件搜索。
      // ⚠ 插入的引用 source 必须写 'reference'：codec 与「点引用预览」都按来源名路由，
      //    写自己的名字会让提交时找不到序列化实现（发送直接失败）。
      ctx.inject(['inputTriggers'], function (scope) {
        var triggers = scope.get('inputTriggers');
        if (!triggers || typeof triggers.registerSource !== 'function') return;
        scope.effect(function () {
          return triggers.registerSource({
            trigger: '@',
            name: 'ide-opened-files',
            order: -1,             // 排在官方 @file / @session 那组前面
            showGroupTitle: false, // 组标题由 section 承担，别多一行
            candidates: function (session, req) {
              var query = String((req && req.query) || '');
              if ((req && req.quoted) || query.trim() !== '') return Promise.resolve([]);
              var files = mentionFilesState.list || [];
              if (!files.length) return Promise.resolve([]);
              // 路径按会话 cwd 解析（引擎就是这么解释 @相对路径 的）；拿不到再退回天工记录的根
              var cwd = '';
              try {
                var byId = sessions && sessions.list && sessions.list.getSnapshot
                  ? sessions.list.getSnapshot().byId : null;
                var rec = byId && session && session.sessionId !== undefined ? byId[session.sessionId] : null;
                cwd = (rec && rec.cwd) || '';
              } catch (e) { cwd = ''; }
              if (!cwd) cwd = mentionFilesState.cwd || '';
              var rows = [], seen = {}, i;
              for (i = 0; i < files.length && rows.length < 3; i++) {
                var f = files[i];
                var path = String((f && f.path) || '');
                var key = path.toLowerCase();
                if (!path || seen[key]) continue;
                seen[key] = true;
                var mention = mentionTextFor(path, cwd);
                if (!mention) continue;
                var label = (f && f.name) || basenameOf(path);
                var row = {
                  name: label,
                  icon: 'file',
                  section: '打开的文件',
                  value: JSON.stringify({ mention: mention, label: label }),
                };
                var desc = mentionDescriptionFor(path, cwd);
                if (desc) row.description = desc;
                rows.push(row);
              }
              return Promise.resolve(rows);
            },
            onPick: function (pick) {
              var v = null;
              try { v = JSON.parse(String((pick && pick.candidate && pick.candidate.value) || '')); } catch (e) { v = null; }
              if (!v || !v.mention) return undefined;
              return {
                insert: {
                  source: 'reference',
                  ref: v.mention,
                  label: v.label,
                  appearance: 'file',
                  clipboardText: v.mention,
                },
              };
            },
            codec: {
              clipboardText: function (ref) { return ref; },
              serialize: function (ref) { return Promise.resolve(ref); },
            },
          });
        }, 'dsh-ide: @ opened files');
      });
      // 平台把"工作空间导航"（选目录 / 连接 / 开会话）放在 uiWorkspace 服务上；
      // `workspaces` 只是注册表（create/rename/delete/insert…），**没有** pickDirectory/connectWorkspace
      // —— 2026-09-17 实测踩到（"workspaces.connectWorkspace is not a function"）。
      // ⚠ 2026-09-20 改：**不能 inject 'uiWorkspace'**（会与该插件形成循环等待）——
      //   ui-workspace 自己 inject `layout`，而 `layout` 由本插件提供（ui-layout 在 app 侧被 disabled）。
      //   注入它 = 双方互等、13 个客户端插件全 pending。改成**惰性取**：调用那一刻再 ctx.get。
      var uiWorkspaceFace = {
        pickDirectory: function () {
          var s = ctx.get('uiWorkspace');
          return s ? s.pickDirectory() : Promise.resolve(null);
        },
        connectWorkspace: function (id) {
          var s = ctx.get('uiWorkspace');
          return s ? s.connectWorkspace(id) : Promise.reject(new Error('uiWorkspace 还没就绪'));
        },
        openSession: function (id) {
          var s = ctx.get('uiWorkspace');
          if (s) s.openSession(id);
        },
      };
      // 0.2.1 起"当前会话"搬到了 **uiSession 的主视图绑定**上（会话列表快照里的 current 字段被删）：
      // 平台导航 uiWorkspace.openSession(id) → sessions.retain(id, {source:'mainView'}) →
      // uiSession.adapter.current 指向它（`key` 就是 sessionId；空会话没被列表接住时该绑定为 absent）。
      // ⚠ 同样**不能 inject 'uiSession'**：它与 ui-workspace 依赖同一批服务、会一起循环等待
      //   layout（本插件提供），一律惰性 ctx.get（同 uiWorkspaceFace 的理由）。
      var uiSessionFace = {
        /** @returns 主视图绑定的订阅源（HostObservable）；服务未就绪时为 null */
        currentSource: function () {
          var s = ctx.get('uiSession');
          var src = s && s.adapter && s.adapter.current;
          return (src && src.getSnapshot && src.subscribe) ? src : null;
        },
        /** @returns 平台当前会话 id；无当前会话（含空会话尚未进列表）时为 undefined */
        currentId: function () {
          var src = uiSessionFace.currentSource();
          var v = src ? src.getSnapshot() : null;
          return (v && v.key) || undefined;
        },
      };
      var themeService = ctx.get('theme');

      // ── 全局错误自动记录（使用轨迹/报错日志，无需用户转述）──
      var onWinError = function (ev) {
        trace('client', 'error', 'window.onerror: ' + String((ev && ev.message) || ''), {
          file: (ev && ev.filename) || undefined,
          line: (ev && ev.lineno) || undefined,
        });
      };
      var onUnhandled = function (ev) {
        var r = ev && ev.reason;
        trace('client', 'error', 'unhandledrejection: ' + String((r && r.message) || r || ''), {
          stack: (r && r.stack) ? String(r.stack).slice(0, 2000) : undefined,
        });
      };
      window.addEventListener('error', onWinError);
      window.addEventListener('unhandledrejection', onUnhandled);
      window.addEventListener('beforeunload', flushTrace);
      ctx.effect(function () {
        return function () {
          window.removeEventListener('error', onWinError);
          window.removeEventListener('unhandledrejection', onUnhandled);
          window.removeEventListener('beforeunload', flushTrace);
        };
      }, 'dsh-ide: trace handlers');

      // 主题切换事件桥（组件内没有 ctx，经 bus 转发 theme/change）
      var themeBus = { listeners: [] };
      if (themeService) {
        ctx.on('theme/change', function (snapshot) {
          presentTheme(snapshot);
          for (var i = 0; i < themeBus.listeners.length; i++) themeBus.listeners[i](snapshot);
        });
        // 应用只有深色模式（2026-09-17 用户要求：永久去掉日间/夜间切换）。
        // 标题栏按钮与命令面板条目都已删除，这里再兜一道 —— 外部（旧设置/系统跟随）
        // 把偏好弄成亮色时自动收敛回 dark。
        try {
          var snap = themeService.getTheme ? themeService.getTheme() : null;
          presentTheme(snap);
          var mode = snap
            ? (snap.preference === 'system' ? (snap.active && snap.active.colorScheme) : snap.preference)
            : null;
          if (mode !== 'dark' && typeof themeService.setTheme === 'function') themeService.setTheme('dark');
        } catch (e) { /* 主题服务异常不影响 IDE */ }
      }

      // ── 平台外壳三件套：本 profile 关掉了 ui-layout，这三样被整条会话链依赖，由我们顶上 ──
      // 为什么不能"直接用平台的"：ui-layout 把「服务 + panelInfo 席位 + frame 注册」塞在同一个
      // effect 里，而 frame 会声明 root 的四个子槽 —— 我们要自己声明才渲染得到 main（会话树）。
      // 客户端插件收不到行 config（浏览器侧条目只有 {id,url,rev,inject}），所以没法只关 frame，
      // 只能整行 disabled 并把这三样补上（2026-09-20，见 00devCore §3「平台会话接入」）。
      ctx.effect(function () {
        var disposers = [];
        // ① ctx.layout 兼容壳：ui-chat / ui-tool / ui-workspace / ui-sidebar 都 inject 它。
        //    天工自绘三栏、不渲染平台侧栏，所以这些动作只保证"调用不炸"。
        var nav = new AbortController();
        // panelInfo：天工"中央面板"永远是编辑器 → activePanelId 恒为 null（平台语义 = 显示会话），
        // 所以 getSnapshot 是常量。重点是它**同时是服务属性**：新版 ILayout.panelInfo 被消费方
        // 当服务读（ui-sidebar-right / ui-plugin-manager 在 apply 里就 subscribe），只给席位
        //（root hook）不给服务面 → 那两个 apply 抛错、连带 9 个等 sidebarRight 的插件全 pending
        //（2026-10-10 新引擎实测）。席位与服务面共用同一个对象，和平台 ui-layout 一致。
        var panelInfo = {
          getSnapshot: function () { return { activePanelId: null } },
          subscribe: function () { return function () {} },
        };
        var layoutFace = {
          panelInfo: panelInfo,
          selectPanel: function () { /* 天工只有一个中央面板（编辑器） */ },
          beginNavigation: function () {
            try { nav.abort() } catch (e) { /* 已中止 */ }
            nav = new AbortController();
            return nav.signal;
          },
          toggleSidebar: function () { /* 无平台侧栏 */ },
          openRightbar: function () { /* 无平台右栏 */ },
          closeRightbar: function () { /* 无平台右栏 */ },
        };
        try {
          if (ctx.reflect && typeof ctx.reflect.provide === 'function') {
            var p = ctx.reflect.provide('layout', layoutFace);
            disposers.push(function () { try { if (typeof p === 'function') p() } catch (e) { /* 忽略 */ } });
          }
        } catch (e) { trace('client', 'error', 'layout-service-provide-failed', { error: String((e && e.message) || e) }) }
        // ② panelInfo 席位：会话里的组件都要 `usePanelInfo` 这个 global 标准 prop。
        try {
          if (ctx.slots && typeof ctx.slots.provideRoot === 'function') {
            disposers.push(ctx.slots.provideRoot({ hooks: { panelInfo: panelInfo } }));
          }
        } catch (e) { trace('client', 'error', 'panel-info-provide-failed', { error: String((e && e.message) || e) }) }
        return function () {
          // 官方 LayoutController.dispose() 卸载时会让 pending 导航失效（service.ts:88）；
          // 漏了这句，消费者手里那个 signal 永不中止、await 它的导航会一直挂着。
          try { nav.abort() } catch (e) { /* 已中止 */ }
          for (var i = disposers.length - 1; i >= 0; i--) { try { disposers[i]() } catch (e) { /* 忽略 */ } }
        };
      }, 'dsh-ide: platform shell services');
      ctx.effect(function () {
        // 天工 = 那个窗口：以更低 priority 换掉默认布局，并**自己声明 root 的子槽**。
        // 为什么必须声明（2026-09-20 改）：平台的会话 UI 是一棵槽树
        //   root → main（keyed，entryKey='conversation'）→ conversation.session（消息/工具卡）
        //                                               → conversation.composer（输入框，提问就靠"接管输入框"）
        // 槽规则是"声明即认领，一个槽只能一个声明者"。以前不声明 children，等于把这棵树
        // 从根上拔了 → 提问卡片（ask_user_question）没有地方渲染、那一轮就卡住。
        // 现在：平台 AppFrame 已由 profile 关掉（ui-layout config.frame=false），子槽归我们声明，
        // 我们只渲染 main（放进右侧 Agent 面板）与 shell.overlay（平台弹层/提示）；
        // 其余声明但不渲染 —— 平台那些占用者照样注册成功（它们走
        // ctx.slots.inject，等声明出现），只是不显示，天工用自绘的文件树代替。
        // ⚠ 平台插件是 inject 等待声明的，所以"我们晚于它们加载"完全没问题。
        // ⚠ 这张表必须与官方 ui-layout 的 AppFrame 子槽表**逐字对齐**（带不带、kind 错一个都不行）：
        //   sidebar / main / rightbar / shell.bottom / shell.overlay / shell.leading。
        //   漏一个的后果不是报错而是**静默等死**：占它的官方插件那个 inject 效果永不触发
        //   （shell.leading 归 ui-sidebar 的窗口左上控件、shell.bottom 归 inspector）。
        //   2026-10-13 S4 核对时补齐后两个 —— 此前只有四个，正好漏掉这两个。
        return ctx.slots.register({
          name: 'root',
          priority: -100,
          children: {
            'sidebar': { kind: 'single', scope: 'root' },
            'main': { kind: 'keyed', scope: 'root' },
            'rightbar': { kind: 'single', scope: 'root' },
            'shell.bottom': { kind: 'single', scope: 'root' },
            'shell.overlay': { kind: 'list', scope: 'root' },
            'shell.leading': { kind: 'single', scope: 'root' },
          },
        }, function (props) {
          return h(IdeApp, {
            workspaces: workspaces, sessions: sessions, uiWorkspace: uiWorkspaceFace,
            uiSession: uiSessionFace,
            theme: themeService, themeBus: themeBus, renderSlot: props && props.renderSlot,
          });
        });
      }, 'dsh-ide: app body');

      ctx.effect(function () {
        // 对话回退：把"每轮回复末尾的横线 + 按钮"挂到官方对话的轮尾插槽上。
        // 用 slots.inject 等这个槽出现（槽由 ui-chat 声明 —— 我们不改官方源码，只在它的落点上放自己的东西）。
        return ctx.slots.inject('conversation.chat.turnTail', function () {
          return ctx.slots.register({
            name: 'conversation.chat.turnTail',
            id: 'dside-rewind',
            order: 90,                       // 排在官方那几个轮尾卡片后面
            inject: function (sessionId) { return { sessionId: String(sessionId) }; },
          }, RewindTailEntry);
        });
      }, 'dsh-ide: rewind turn-tail entry');
    }

    module.exports = { inject: ['slots', 'workspaces', 'sessions'], apply: apply };
    return module.exports;
  },
});
