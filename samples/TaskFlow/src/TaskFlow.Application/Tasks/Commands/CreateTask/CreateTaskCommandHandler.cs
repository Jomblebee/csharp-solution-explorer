using MediatR;
using TaskFlow.Application.Common.Interfaces;
using TaskFlow.Domain.Entities;

namespace TaskFlow.Application.Tasks.Commands.CreateTask;

public class CreateTaskCommandHandler(ITaskFlowDbContext db)
    : IRequestHandler<CreateTaskCommand, int>
{
    public async Task<int> Handle(CreateTaskCommand request, CancellationToken cancellationToken)
    {
        var task = new AppTask
        {
            ProjectId = request.ProjectId,
            Title = request.Title,
            Description = request.Description,
            Priority = request.Priority
        };
        db.Tasks.Add(task);
        await db.SaveChangesAsync(cancellationToken);
        return task.Id;
    }
}
