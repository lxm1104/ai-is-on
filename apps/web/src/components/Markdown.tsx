import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown(props: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, ...rest }) => <a target="_blank" rel="noreferrer" {...rest} />,
        }}
      >
        {props.children}
      </ReactMarkdown>
    </div>
  );
}
