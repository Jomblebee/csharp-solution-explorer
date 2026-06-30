using TaskFlow.Domain.Enums;

namespace TaskFlow.Domain.Entities;

public class AppTask
{
    public int Id { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public AppTaskStatus Status { get; set; } = AppTaskStatus.Todo;
    public Priority Priority { get; set; } = Priority.Medium;
    public int ProjectId { get; set; }
    public Project Project { get; set; } = null!;
    public ICollection<Tag> Tags { get; set; } = [];
}
