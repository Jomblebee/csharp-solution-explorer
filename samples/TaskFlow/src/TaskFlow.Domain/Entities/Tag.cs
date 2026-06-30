namespace TaskFlow.Domain.Entities;

public class Tag
{
    public int Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public ICollection<AppTask> Tasks { get; set; } = [];
}
