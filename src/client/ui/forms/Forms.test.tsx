import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Checkbox, CheckboxGroup, FileDropzone, FormActions, NumberInput, PasswordInput, RadioGroup,
  Select, Switch, TextArea, TextInput } from "./index.tsx";

describe("design system forms", () => {
  it("associates labels, descriptions and errors with native controls", () => {
    const markup = renderToStaticMarkup(<TextInput id="drawing-name" label="图纸名称" description="使用图框中的正式名称"
      error="名称不能为空" required />);

    expect(markup).toContain('for="drawing-name"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-describedby="drawing-name-description drawing-name-error"');
    expect(markup).toContain('id="drawing-name-error"');
  });

  it("covers the Phase 2 input families with native semantics", () => {
    const markup = renderToStaticMarkup(<>
      <PasswordInput id="password" label="密码" />
      <TextArea id="comment" label="处理说明" maxLength={500} />
      <Select id="role" label="项目角色" options={[{ value: "viewer", label: "只读成员" }]} />
      <NumberInput id="revision" label="版本序号" min={0} />
      <Checkbox id="ack" label="我已核对图纸" />
      <CheckboxGroup legend="输出文件"><Checkbox id="signed" label="签后 PDF" /></CheckboxGroup>
      <RadioGroup legend="审核结论" name="result" options={[{ value: "approved", label: "通过" }]} />
      <Switch id="notify" label="邮件通知" />
      <FileDropzone id="drawing" label="上传 PDF" accept="application/pdf" />
      <FormActions><button type="submit">保存</button></FormActions>
    </>);

    expect(markup).toContain('type="password"');
    expect(markup).toContain("<textarea");
    expect(markup).toContain("<select");
    expect(markup).toContain('type="number"');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('type="radio"');
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('type="file"');
  });
});
